/**
 * Avatar camera carrier.
 *
 * Playwright Chromium does not ship an H.264 WebCodecs decoder. Decode the
 * backend's Annex-B stream with the image's existing ffmpeg, send independent
 * JPEG frames across Playwright, and paint them onto a document-start canvas
 * whose track is substituted into the meeting's WebRTC senders.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Page } from 'playwright';

const MAX_JPEG_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_H264_CHUNK_BYTES = 8 * 1024 * 1024;

export interface VideoCarrier {
  pushVideo(h264: Buffer, frameCount?: number): void;
  tagTurnEnd(acknowledge: () => void): void;
  stop(): Promise<void>;
}

type SpawnDecoder = (
  command: string,
  args: string[],
  options: { stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcess;

export function createVideoCarrier(
  page: Page,
  log: (message: string) => void,
  spawnDecoder: SpawnDecoder = (command, args, options) => spawn(command, args, options),
): VideoCarrier {
  let decoder: ChildProcess | null = null;
  let jpegBuffer = Buffer.alloc(0);
  let pendingFrame: { bytes: Buffer; sequence: number } | null = null;
  let draining = false;
  let inputBlocked = false;
  let stopped = false;
  let acceptedFrameSequence = 0;
  let decodedFrameSequence = 0;
  let paintedFrameSequence = 0;
  const pendingTurnEnds: Array<{ target: number; acknowledge: () => void }> = [];

  function flushTurnEnds(): void {
    while (pendingTurnEnds.length > 0 && pendingTurnEnds[0].target <= paintedFrameSequence) {
      const turn = pendingTurnEnds.shift();
      try { turn?.acknowledge(); } catch { /* listener must not break the carrier */ }
    }
  }

  function discardTurnEnds(reason: string): void {
    if (pendingTurnEnds.length > 0) {
      log(`[humanty-cam] ${reason}; discarding ${pendingTurnEnds.length} unpaintable turn(s)`);
    }
    pendingTurnEnds.length = 0;
    acceptedFrameSequence = decodedFrameSequence;
  }

  function drainJpegs(data: Buffer): void {
    jpegBuffer = Buffer.concat([jpegBuffer, data]);
    while (jpegBuffer.length > 0) {
      const start = jpegBuffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        jpegBuffer = jpegBuffer.subarray(Math.max(0, jpegBuffer.length - 1));
        return;
      }
      const end = jpegBuffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) {
        if (start > 0) jpegBuffer = jpegBuffer.subarray(start);
        if (jpegBuffer.length > MAX_JPEG_BUFFER_BYTES) {
          log('[humanty-cam] oversized partial JPEG dropped');
          jpegBuffer = Buffer.alloc(0);
        }
        return;
      }
      decodedFrameSequence++;
      pendingFrame = {
        bytes: jpegBuffer.subarray(start, end + 2),
        sequence: decodedFrameSequence,
      };
      jpegBuffer = jpegBuffer.subarray(end + 2);
      if (!draining) void sendLatestFrame();
    }
  }

  async function sendLatestFrame(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (!stopped && pendingFrame) {
        const frame = pendingFrame;
        pendingFrame = null;
        await page.evaluate(async (b64: string) => {
          const root = globalThis as unknown as {
            __humanty_pushVideo?: (jpeg: string) => Promise<void>;
          };
          if (!root.__humanty_pushVideo) throw new Error('canvas video carrier is unavailable');
          await root.__humanty_pushVideo(b64);
        }, frame.bytes.toString('base64'));
        paintedFrameSequence = Math.max(paintedFrameSequence, frame.sequence);
        flushTurnEnds();
      }
    } catch (error) {
      // Navigation destroys the old execution context. JPEGs are independent,
      // so discard the stale frame and let the next one paint on the new page.
      pendingFrame = null;
      discardTurnEnds('page paint failed');
      log(`[humanty-cam] page handoff interrupted: ${String(error)}`);
    } finally {
      draining = false;
      if (!stopped && pendingFrame) void sendLatestFrame();
    }
  }

  function ensureDecoder(): void {
    if (decoder || stopped) return;
    const child = spawnDecoder('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-fflags', 'nobuffer', '-flags', 'low_delay',
      '-probesize', '32', '-analyzeduration', '0',
      '-f', 'h264', '-i', 'pipe:0',
      '-an', '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:black',
      '-c:v', 'mjpeg', '-q:v', '5', '-threads', '2',
      '-f', 'image2pipe', '-flush_packets', '1', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    decoder = child;
    child.stdout?.on('data', (data: Buffer) => drainJpegs(data));
    child.stderr?.on('data', (data: Buffer) => {
      const message = data.toString().trim();
      if (message) log(`[humanty-cam] ffmpeg: ${message.slice(0, 300)}`);
    });
    child.stdin?.on('error', () => { /* decoder exited between packets */ });
    child.stdin?.on('drain', () => { inputBlocked = false; });
    child.on('error', (error) => {
      log(`[humanty-cam] ffmpeg spawn failed: ${error.message}`);
      if (decoder === child) {
        decoder = null;
        inputBlocked = false;
        discardTurnEnds('decoder spawn failed');
      }
    });
    child.on('exit', (code, signal) => {
      if (!stopped) log(`[humanty-cam] ffmpeg exited code=${code} signal=${signal ?? ''}`);
      if (decoder === child) {
        decoder = null;
        inputBlocked = false;
        discardTurnEnds('decoder exited');
      }
    });
  }

  return {
    pushVideo(h264: Buffer, frameCount = 1): void {
      if (stopped || h264.length === 0) return;
      if (h264.length > MAX_H264_CHUNK_BYTES) {
        log(`[humanty-cam] oversized H.264 chunk dropped (${h264.length} bytes)`);
        return;
      }
      ensureDecoder();
      if (!decoder?.stdin || decoder.stdin.destroyed || inputBlocked) return;
      try {
        // Never queue an unbounded live stream behind a stalled decoder. If
        // ffmpeg applies backpressure, drop until its bounded pipe drains; the
        // next IDR repairs any partial GOP.
        inputBlocked = !decoder.stdin.write(h264);
        acceptedFrameSequence += Math.max(1, Math.floor(frameCount));
      }
      catch { /* a later packet restarts the decoder */ }
    },
    tagTurnEnd(acknowledge: () => void): void {
      const target = acceptedFrameSequence;
      if (target === 0) {
        log('[humanty-cam] zero-frame turn left for backend timeout fallback');
        return;
      }
      if (paintedFrameSequence >= target) {
        try { acknowledge(); } catch { /* listener must not break the carrier */ }
        return;
      }
      pendingTurnEnds.push({ target, acknowledge });
    },
    async stop(): Promise<void> {
      stopped = true;
      pendingFrame = null;
      jpegBuffer = Buffer.alloc(0);
      pendingTurnEnds.length = 0;
      const child = decoder;
      decoder = null;
      try { child?.stdin?.end(); } catch { /* best-effort */ }
      try { child?.kill('SIGTERM'); } catch { /* best-effort */ }
    },
  };
}

export const PAGE_VIDEO_CARRIER = String.raw`
(() => {
  'use strict';
  const w = globalThis;
  if (w.__humanty_camera_stats && w.__humanty_camera_stats.installed) return;

  const stats = {
    installed: true,
    gumCalls: 0,
    addTrackSubstitutions: 0,
    replaceTrackSubstitutions: 0,
    activations: 0,
    decodedFrames: 0,
    paintedFrames: 0,
    decodeErrors: 0,
    lastError: '',
    trackedPeers: 0,
  };
  w.__humanty_camera_stats = stats;

  const canvas = document.createElement('canvas');
  canvas.id = '__humanty_avatar_camera';
  canvas.width = 1280;
  canvas.height = 720;
  canvas.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px';
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) {
    stats.lastError = '2d canvas unavailable';
    console.error('[humanty-page-video] ' + stats.lastError);
    return;
  }
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const stream = canvas.captureStream(25);
  const canvasTrack = stream.getVideoTracks()[0];
  if (!canvasTrack) {
    stats.lastError = 'canvas capture track unavailable';
    console.error('[humanty-page-video] ' + stats.lastError);
    return;
  }
  canvasTrack.contentHint = 'motion';
  w.__humanty_canvas = canvas;
  w.__humanty_canvas_ctx = ctx;
  w.__humanty_canvas_stream = stream;

  const appendCanvas = () => {
    if (document.body && !canvas.isConnected) document.body.appendChild(canvas);
  };
  appendCanvas();
  document.addEventListener('DOMContentLoaded', appendCanvas, { once: true });

  // captureStream emits only when the canvas changes. Keep a black camera live
  // before the first avatar frame and keep the last frame live between turns.
  let pump = false;
  const pumpFrame = () => {
    pump = !pump;
    ctx.fillStyle = pump ? '#000000' : '#000001';
    ctx.fillRect(0, 0, 1, 1);
    requestAnimationFrame(pumpFrame);
  };
  requestAnimationFrame(pumpFrame);

  const peers = new Set();
  const mediaDevices = navigator.mediaDevices;
  if (mediaDevices && typeof mediaDevices.getUserMedia === 'function') {
    const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
    Object.defineProperty(mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async (constraints) => {
        if (!constraints || !constraints.video) return originalGetUserMedia(constraints);
        stats.gumCalls++;
        const result = new MediaStream();
        result.addTrack(canvasTrack.clone());
        if (constraints.audio) {
          const audio = await originalGetUserMedia({ audio: constraints.audio, video: false });
          for (const track of audio.getAudioTracks()) result.addTrack(track);
        }
        return result;
      },
    });
  }

  const pcProto = w.RTCPeerConnection && w.RTCPeerConnection.prototype;
  const senderProto = w.RTCRtpSender && w.RTCRtpSender.prototype;
  const originalAddTrack = pcProto && pcProto.addTrack;
  const originalReplaceTrack = senderProto && senderProto.replaceTrack;
  if (originalAddTrack) {
    pcProto.addTrack = function(track, ...streams) {
      peers.add(this);
      stats.trackedPeers = peers.size;
      if (track && track.kind === 'video') {
        stats.addTrackSubstitutions++;
        return originalAddTrack.call(this, canvasTrack, ...streams);
      }
      return originalAddTrack.call(this, track, ...streams);
    };
  }
  const originalClose = pcProto && pcProto.close;
  if (originalClose) {
    pcProto.close = function(...args) {
      try { return originalClose.apply(this, args); }
      finally {
        peers.delete(this);
        stats.trackedPeers = peers.size;
      }
    };
  }
  if (originalReplaceTrack) {
    senderProto.replaceTrack = function(track) {
      if (track && track.kind === 'video' && track.id !== canvasTrack.id) {
        stats.replaceTrackSubstitutions++;
        return originalReplaceTrack.call(this, canvasTrack);
      }
      return originalReplaceTrack.call(this, track);
    };
  }

  w.__humanty_activateCamera = async () => {
    stats.activations++;
    let replaced = 0;
    if (!originalReplaceTrack) return replaced;
    for (const pc of Array.from(peers)) {
      if (pc.connectionState === 'closed' || pc.signalingState === 'closed') {
        peers.delete(pc);
        stats.trackedPeers = peers.size;
        continue;
      }
      for (const sender of pc.getSenders()) {
        if (sender.track && sender.track.kind === 'video' && sender.track.id !== canvasTrack.id) {
          await originalReplaceTrack.call(sender, canvasTrack);
          replaced++;
        }
      }
    }
    return replaced;
  };

  let pendingJpeg = null;
  let painting = false;
  let pushedFrame = 0;
  let paintedFrame = 0;
  const paintWaiters = [];

  function resolvePaintWaiters() {
    while (paintWaiters.length && paintWaiters[0].target <= paintedFrame) {
      paintWaiters.shift().resolve();
    }
  }

  async function paintLatest() {
    if (painting) return;
    painting = true;
    try {
      while (pendingJpeg) {
        const pending = pendingJpeg;
        pendingJpeg = null;
        const encoded = pending.encoded;
        const raw = atob(encoded);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        stats.decodedFrames++;
        const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
        const dw = Math.round(bitmap.width * scale);
        const dh = Math.round(bitmap.height * scale);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
        bitmap.close();
        stats.paintedFrames++;
        paintedFrame = pending.sequence;
        resolvePaintWaiters();
        if (stats.paintedFrames === 1) console.log('[humanty-page-video] first frame painted');
      }
    } catch (error) {
      stats.decodeErrors++;
      stats.lastError = String(error);
      console.warn('[humanty-page-video] JPEG paint error', error);
    } finally {
      painting = false;
      if (pendingJpeg) void paintLatest();
    }
  }

  w.__humanty_pushVideo = (jpeg) => new Promise((resolve) => {
    const sequence = ++pushedFrame;
    pendingJpeg = { encoded: jpeg, sequence };
    paintWaiters.push({ target: sequence, resolve });
    void paintLatest();
  });

  console.log('[humanty-page-video] canvas camera ready');
})();
`;
