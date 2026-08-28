import assert from 'node:assert/strict';
import { type ChildProcess, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chromium, type Page } from 'playwright';
import { createVideoCarrier, PAGE_VIDEO_CARRIER, type VideoCarrier } from './video-carrier.js';

function fakeDecoder(onWrite?: () => void): ChildProcess {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    write: () => { onWrite?.(); return true; },
    end: () => {},
  });
  child.kill = () => true;
  return child as unknown as ChildProcess;
}

const emptyCarrier = createVideoCarrier({} as Page, () => {});
let emptyTurnPlayed = false;
emptyCarrier.tagTurnEnd(() => { emptyTurnPlayed = true; });
assert.equal(emptyTurnPlayed, false, 'a zero-frame turn must use the backend timeout fallback');
await emptyCarrier.stop();

const exitedDecoder = fakeDecoder();
const exitedCarrier = createVideoCarrier(
  {} as Page,
  () => {},
  () => exitedDecoder,
);
let exitedTurnPlayed = false;
exitedCarrier.pushVideo(Buffer.from([0, 0, 0, 1]), 1);
exitedCarrier.tagTurnEnd(() => { exitedTurnPlayed = true; });
exitedDecoder.emit('exit', 1, null);
assert.equal(exitedTurnPlayed, false, 'decoder exit must not ACK an unpainted turn');
await exitedCarrier.stop();

const rejectedPageDecoder = fakeDecoder();
const rejectedPage = {
  evaluate: async () => { throw new Error('execution context lost'); },
} as unknown as Page;
const rejectedPageCarrier = createVideoCarrier(
  rejectedPage,
  () => {},
  () => rejectedPageDecoder,
);
let rejectedPageTurnPlayed = false;
rejectedPageCarrier.pushVideo(Buffer.from([0, 0, 0, 1]), 1);
rejectedPageCarrier.tagTurnEnd(() => { rejectedPageTurnPlayed = true; });
rejectedPageDecoder.stdout?.emit('data', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(rejectedPageTurnPlayed, false, 'page paint rejection must not ACK the turn');
await rejectedPageCarrier.stop();

const encoded = spawnSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc=size=512x512:rate=25:duration=2',
  '-c:v', 'libx264', '-profile:v', 'baseline', '-tune', 'zerolatency',
  '-x264-params', 'keyint=25:min-keyint=25:scenecut=0',
  '-pix_fmt', 'yuv420p', '-f', 'h264', 'pipe:1',
], { maxBuffer: 4 * 1024 * 1024 });
assert.equal(encoded.status, 0, encoded.stderr.toString());
assert(encoded.stdout.length > 0, 'ffmpeg emitted no H.264');

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
let carrier: VideoCarrier | null = null;

try {
  const context = await browser.newContext();
  await context.grantPermissions(['camera'], { origin: 'https://camera.test' });
  await context.addInitScript({ content: PAGE_VIDEO_CARRIER });
  const page = await context.newPage();
  const pageMessages: string[] = [];
  page.on('console', (message) => pageMessages.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => pageMessages.push(`pageerror: ${error.message}`));
  await page.route('https://camera.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><body>camera test</body></html>',
  }));
  await page.goto('https://camera.test/');

  const camera = await page.evaluate(async () => {
    const w = window as unknown as {
      __humanty_canvas_stream?: MediaStream;
      __humanty_camera_stats?: { installed: boolean; trackedPeers: number };
    };
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    const canvasTrack = w.__humanty_canvas_stream?.getVideoTracks()[0];
    if (!canvasTrack) throw new Error('missing canvas camera track');

    const otherCanvas = document.createElement('canvas');
    const otherTrack = otherCanvas.captureStream(1).getVideoTracks()[0];
    const pc = new RTCPeerConnection();
    const sender = pc.addTrack(otherTrack);
    const addTrackSubstituted = sender.track?.id === canvasTrack.id;
    await sender.replaceTrack(otherTrack);
    const replaceTrackSubstituted = sender.track?.id === canvasTrack.id;
    pc.close();

    return {
      installed: w.__humanty_camera_stats?.installed === true,
      gumKind: stream.getVideoTracks()[0]?.kind,
      addTrackSubstituted,
      replaceTrackSubstituted,
      trackedPeers: w.__humanty_camera_stats?.trackedPeers,
    };
  });
  assert.deepEqual(camera, {
    installed: true,
    gumKind: 'video',
    addTrackSubstituted: true,
    replaceTrackSubstituted: true,
    trackedPeers: 0,
  });

  carrier = createVideoCarrier(page, (message) => pageMessages.push(message));
  let turnPlayed = false;
  let resolveTurnPlayed: (() => void) | undefined;
  const turnPlayedPromise = new Promise<void>((resolve) => { resolveTurnPlayed = resolve; });
  carrier.pushVideo(encoded.stdout, 50);
  carrier.tagTurnEnd(() => {
    turnPlayed = true;
    resolveTurnPlayed?.();
  });
  assert.equal(turnPlayed, false, 'turn ACK must not fire before a carrier frame paints');

  try {
    await page.waitForFunction(() => {
      const stats = (window as unknown as {
        __humanty_camera_stats?: { decodedFrames: number; paintedFrames: number };
      }).__humanty_camera_stats;
      return !!stats && stats.decodedFrames > 0 && stats.paintedFrames > 0;
    });
  } catch (error) {
    const stats = await page.evaluate(() =>
      (window as unknown as { __humanty_camera_stats?: unknown }).__humanty_camera_stats);
    console.error('camera stats:', stats);
    console.error(pageMessages.join('\n'));
    throw error;
  }

  const pixel = await page.evaluate(() => {
    const canvas = (window as unknown as { __humanty_canvas?: HTMLCanvasElement }).__humanty_canvas;
    if (!canvas) throw new Error('missing camera canvas');
    const data = canvas.getContext('2d')?.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
    return data ? Array.from(data) : [];
  });
  assert(pixel[0] + pixel[1] + pixel[2] > 100,
    `decoded frame remained black: rgba=${pixel.join(',')}`);
  // The streaming ffmpeg decoder retains a tail until the next H.264 batch.
  // A following silence/video batch must advance the paint fence for turn_end.
  carrier.pushVideo(encoded.stdout, 50);
  try {
    await Promise.race([
      turnPlayedPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('turn paint ACK timed out')), 5_000)),
    ]);
  } catch (error) {
    const stats = await page.evaluate(() =>
      (window as unknown as { __humanty_camera_stats?: unknown }).__humanty_camera_stats);
    console.error('turn ACK camera stats:', stats);
    console.error(pageMessages.join('\n'));
    throw error;
  }
  assert.equal(turnPlayed, true);
} finally {
  await carrier?.stop();
  await browser.close();
}

console.log('video-carrier.test.ts: PASS');
