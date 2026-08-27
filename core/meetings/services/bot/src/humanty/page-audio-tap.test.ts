import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PAGE_AUDIO_TAP } from './page-audio-tap.js';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: String.raw`
    (() => {
      const stats = { binds: 0, pushes: 0, recorderStops: 0 };
      window.__audioTestStats = stats;
      const originalCreate = AudioContext.prototype.createMediaElementSource;
      AudioContext.prototype.createMediaElementSource = function(element) {
        stats.binds++;
        return originalCreate.call(this, element);
      };
      class FakeRecorder {
        static current = null;
        constructor() { FakeRecorder.current = this; }
        async start() { if (this.initSourceNode) await this.initSourceNode(); }
        stop() { stats.recorderStops++; }
        emit(chunk) { if (this.ondataavailable) this.ondataavailable(chunk); }
      }
      window.Recorder = FakeRecorder;
      window.__fakeRecorder = FakeRecorder;
      window.__humantyGetEncoderUrl = async () => 'data:application/javascript,';
      let releasePush = null;
      window.__releaseAudioPush = () => {
        if (releasePush) releasePush();
        releasePush = null;
      };
      window.__humanty_pushOpus = async () => {
        stats.pushes++;
        await new Promise((resolve) => { releasePush = resolve; });
      };
    })();
  ` });
  await page.addScriptTag({ content: PAGE_AUDIO_TAP });

  await page.waitForFunction(() =>
    !!(window as unknown as { __humanty_audioRec?: unknown }).__humanty_audioRec);
  await page.evaluate(() => {
    document.body.appendChild(document.createElement('audio'));
  });
  await page.waitForFunction(() =>
    (window as unknown as { __audioTestStats: { binds: number } }).__audioTestStats.binds === 1,
  undefined, { timeout: 2_000 });

  const pushesWhileBlocked = await page.evaluate(async () => {
    const FakeRecorder = (window as unknown as {
      __fakeRecorder: { current: { emit(chunk: Uint8Array): void } };
    }).__fakeRecorder;
    const stats = (window as unknown as { __audioTestStats: { pushes: number } }).__audioTestStats;
    FakeRecorder.current.emit(new Uint8Array([1, 2, 3]));
    FakeRecorder.current.emit(new Uint8Array([4, 5, 6]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    return stats.pushes;
  });
  assert.equal(pushesWhileBlocked, 1, 'only one page-to-node audio push may be outstanding');

  await page.evaluate(async () => {
    (window as unknown as { __releaseAudioPush: () => void }).__releaseAudioPush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const FakeRecorder = (window as unknown as {
      __fakeRecorder: { current: { emit(chunk: Uint8Array): void } };
    }).__fakeRecorder;
    FakeRecorder.current.emit(new Uint8Array(300 * 1024));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const pushCount = await page.evaluate(() =>
    (window as unknown as { __audioTestStats: { pushes: number } }).__audioTestStats.pushes);
  assert.equal(pushCount, 1, 'oversized Opus chunks must be dropped in the page');

  const stopped = await page.evaluate(async () => {
    const stop = (window as unknown as { __humanty_stopAudioCapture?: () => Promise<void> })
      .__humanty_stopAudioCapture;
    assert(stop);
    await stop();
    document.body.appendChild(document.createElement('audio'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stats = (window as unknown as {
      __audioTestStats: { binds: number; recorderStops: number };
      __humanty_audioCtx?: AudioContext;
    });
    return {
      binds: stats.__audioTestStats.binds,
      recorderStops: stats.__audioTestStats.recorderStops,
      contextState: stats.__humanty_audioCtx?.state,
    };
  });
  assert.deepEqual(stopped, { binds: 1, recorderStops: 1, contextState: 'closed' });
} finally {
  await browser.close();
}

console.log('page-audio-tap.test.ts: PASS');
