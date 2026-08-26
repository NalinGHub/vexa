/**
 * video-carrier.ts — gets the avatar video IN FRONT OF THE CAMERA.
 *
 * Upstream's de-robot carve (#1054) removed the virtual-camera canvas, and Chromium has
 * no page-level API to swap a camera track once `--use-file-for-fake-video-capture` is
 * pinned at launch. The carrier therefore works at the OS seam:
 *
 *   /v1/video/stream packets ──H.264──► ffmpeg ──raw rgb24──► FIFO
 *                                                            │
 *   Chromium `--use-file-for-fake-video-capture=<FIFO>` ◄────┘
 *
 * Chromium's y4m reader wants a fixed resolution header up front and never re-negotiates,
 * so the backend's 512×512 lipsync feed is letterboxed into a constant 1280×720 frame —
 * the size every platform's camera path accepts without drama. ffmpeg decodes H.264
 * Annex-B (the same bytes the May prototype shipped into the page's WebCodecs decoder)
 * with `-f h264`, so no browser round-trip, no JSON bridge, no page-side code at all.
 *
 * The FIFO is opened lazily on first frame so Chromium can attach its fake camera before
 * any producer exists; frames are dropped (never queued unboundedly) if the reader stalls.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT_W = 1280;
const OUT_H = 720;

export interface VideoCarrier {
  /** Value for Chromium's --use-file-for-fake-video-capture flag. */
  readonly captureArg: string;
  /** Feed one H.264 Annex-B access-unit run (as demuxed from /v1/video/stream). */
  pushVideo(h264: Buffer): void;
  stop(): Promise<void>;
}

export function createVideoCarrier(log: (m: string) => void): VideoCarrier {
  const dir = mkdtempSync(join(tmpdir(), 'humanty-cam-'));
  const fifo = join(dir, 'camera.y4m');

  // Seed the pipe target with a valid y4m header + one black frame so Chromium's probe
  // succeeds the moment it opens the file — even before the first real frame arrives.
  const black = Buffer.alloc(OUT_W * OUT_H * 3);
  writeFileSync(fifo, Buffer.concat([
    Buffer.from(`YUV4MPEG2 W${OUT_W} H${OUT_H} F25:1 Ip A1:1 C420jpeg\n`),
    Buffer.from('FRAME\n'),
    black,
  ]));

  let decoder: ChildProcess | null = null;
  let stopped = false;
  let pending = false;

  function ensureDecoder(): void {
    if (decoder || stopped) return;
    decoder = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-probesize', '32', '-analyzeduration', '0',
      '-f', 'h264', '-i', 'pipe:0',
      '-vf', `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease,pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2:black`,
      '-r', '25',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24',
      fifo,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    decoder.stderr?.on('data', (d) => log(`[humanty-cam] ffmpeg: ${String(d).trim().slice(0, 200)}`));
    decoder.on('exit', (code) => {
      log(`[humanty-cam] ffmpeg exited code=${code}`);
      decoder = null;
    });
  }

  return {
    captureArg: fifo,
    pushVideo(h264: Buffer): void {
      if (stopped || h264.length === 0) return;
      ensureDecoder();
      if (!decoder?.stdin || decoder.stdin.destroyed) return;
      if (pending) return; // previous chunk still draining — drop rather than lag
      pending = true;
      decoder.stdin.write(h264, () => { pending = false; });
      decoder.stdin.on('error', () => { /* reader gone; keep dropping */ });
    },
    async stop() {
      stopped = true;
      try { decoder?.stdin?.end(); } catch { /* ignore */ }
      try { decoder?.kill('SIGTERM'); } catch { /* ignore */ }
      decoder = null;
    },
  };
}
