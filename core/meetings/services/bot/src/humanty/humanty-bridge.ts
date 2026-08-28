/**
 * humanty-bridge.ts — the interviewer-brain adapter (audio in / avatar+voice out).
 *
 * Owns the bot's two WebSocket connections to humanty-backend (loopback) and the
 * audio-out playback chain. Ported from the 2026-05 prototype's
 * vexa-bot/src/services/humanty-bridge.ts onto the rebuilt bot's seams:
 *   • env-config via loadHumantyConfig (the sealed invocation.v1 stays untouched)
 *   • teardown is idempotent + never throws (orchestrator-safe, mirrors #593 rules)
 *   • the "ready" signal feeds the caller's onReady (wired to a lifecycle emit upstream
 *     of this module — see index-humanty.ts — instead of scraping the video stream)
 *
 * Realtime (interviewer brain; OpenAI-Realtime-API style):
 *   ws://<base>/v1/realtime  subprotocol "realtime"
 *   browser → __humanty_pushOpus(base64 Ogg-Opus from opus-recorder in the page)
 *           → input_audio_buffer.append
 *   server  → input_audio_buffer.speech_started (barge-in trigger)
 *           → response.audio.delta (suppressed by use_lip_sync_audio=true)
 *
 * Video (avatar lip-synced video with the answer audio muxed inside):
 *   ws://<base>/v1/video/stream
 *   server → binary v2/v3/v4 packets:
 *     v2: [1B 0x02][2B au_count][4B vlen][4B alen][1B rid_len][8B pts] + rid + H264 + OggOpus
 *     v3: same plus [8B batch_ts_us][4B frame_dur_us] before rid
 *     v4: v3 without batch_ts_us, plus [2B metadata_len] and trailing metadata
 *   we demux: H.264 → onVideo callback (the fake-camera carrier);
 *             Ogg-Opus → ffmpeg → s16le 24k mono → paplay → tts_sink.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import type { Page } from 'playwright';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HumantyConfig } from './config.js';
import { PAGE_AUDIO_TAP } from './page-audio-tap.js';

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const MAX_PAGE_AUDIO_BASE64_CHARS = 512 * 1024;
const MAX_REALTIME_BUFFERED_BYTES = 1024 * 1024;
const MAX_REALTIME_PAYLOAD_BYTES = 1024 * 1024;
const MAX_VIDEO_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_OGG_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_WS_OPEN_TIMEOUT_MS = 5_000;

export interface MuxedFrame {
  frameCount: number;
  requestId: string;
  video: Buffer;
  audio: Buffer;
}

/** Parse one complete backend mux packet. Payload slices share the input buffer. */
export function parseMuxedFrame(buf: Buffer): MuxedFrame | null {
  if (buf.length < 20) return null;
  const type = buf[0];
  const headerSize = type === 0x02 ? 20 : type === 0x03 ? 32 : type === 0x04 ? 26 : 0;
  if (headerSize === 0 || buf.length < headerSize) return null;

  const frameCount = buf.readUInt16BE(1);
  const videoLength = buf.readUInt32BE(3);
  const audioLength = buf.readUInt32BE(7);
  const requestIdLength = buf[11];
  const metadataLength = type === 0x04 ? buf.readUInt16BE(24) : 0;
  const payloadStart = headerSize + requestIdLength;
  const payloadEnd = payloadStart + videoLength + audioLength + metadataLength;
  if (payloadEnd > buf.length) return null;

  return {
    frameCount,
    requestId: requestIdLength > 0
      ? buf.subarray(headerSize, headerSize + requestIdLength).toString('utf8')
      : '',
    video: buf.subarray(payloadStart, payloadStart + videoLength),
    audio: buf.subarray(payloadStart + videoLength, payloadStart + videoLength + audioLength),
  };
}

function pactl(args: string, log: (m: string) => void): void {
  try {
    const child = spawn('pactl', args.split(' '), { stdio: 'ignore' });
    child.on('error', (error) => log(`[humanty] pactl ${args} failed: ${error.message}`));
    child.on('exit', (code) => {
      if (code !== 0) log(`[humanty] pactl ${args} exited ${code}`);
    });
  } catch (e) {
    log(`[humanty] pactl ${args} failed: ${String(e)}`);
  }
}

export interface HumantyBridgeDeps {
  page: Page;
  /** Called once the backend's avatar pipeline reports `ready` (or immediately when the
   *  video stream is unavailable/disabled — the interview proceeds without video). */
  onReady?: () => void;
  /** Called on an unrecoverable bridge fault AFTER start() resolved (post-admission
   *  subsystem faults must degrade loudly but never crash the orchestrator — #593). */
  onError?: (msg: string) => void;
  /** Receives each demuxed Annex-B H.264 run for the canvas camera carrier. */
  onVideo?: (h264: Buffer, frameCount: number) => void;
  /** Defers a turn acknowledgement until the carrier has painted its preceding batch. */
  onTurnEnd?: (acknowledge: () => void) => void;
  /** Test/operations seam for bounded websocket opening. */
  wsOpenTimeoutMs?: number;
  createWebSocket?: (
    url: string,
    protocols: string[],
    options: { maxPayload: number },
  ) => WebSocket;
  log: (m: string) => void;
}

export class HumantyBridge {
  private cfg: HumantyConfig;
  private deps: HumantyBridgeDeps;
  private rt: WebSocket | null = null;
  private vid: WebSocket | null = null;

  private paplayProc: ChildProcess | null = null;
  /** ffmpeg child demuxing+decoding Ogg-Opus → raw PCM into paplay's stdin. */
  private ffmpegProc: ChildProcess | null = null;

  private startPromise: Promise<void> | null = null;
  private audioInputBlocked = false;
  private stopping = false;
  private readySignalled = false;
  private expectedSocketCloses = new WeakSet<WebSocket>();

  constructor(cfg: HumantyConfig, deps: HumantyBridgeDeps) {
    this.cfg = cfg;
    this.deps = deps;
  }

  async start(): Promise<void> {
    if (this.stopping) throw new Error('humanty bridge is stopping');
    if (!this.startPromise) {
      const attempt = (async () => {
        await this.exposePageHooks();
        await this.connectRealtime();
        await this.connectVideo();
        this.deps.log('[humanty] both WS connections open');
      })();
      this.startPromise = attempt.catch(async (error) => {
        await this.rollbackStart();
        this.startPromise = null;
        throw error;
      });
    }
    await this.startPromise;
  }

  /**
   * Install the page-side meeting-audio tap: combines all <audio>/<video>
   * element streams into one Web Audio graph and ships 20 ms Ogg-Opus chunks
   * to __humanty_pushOpus (the interviewer brain's ears). Ported from the
   * prototype's humanty-page-audio.ts; the opus-recorder bundle is vendored
   * at assets/humanty-audio/ (served via a synthetic route so the worker
   * loads). Called by the overlay AFTER admission on the live page.
   */
  async startPageAudioCapture(): Promise<void> {
    const page = this.deps.page;
    // Assets resolve relative to THIS module (dist/humanty/ → ../../assets)
    // so the path works both in-image (/opt/...) and from a repo checkout.
    const here = dirname(fileURLToPath(import.meta.url));
    const assets = process.env.HUMANTY_AUDIO_ASSETS
      ?? join(here, '..', '..', 'assets', 'humanty-audio');

    // The ENCODER WORKER cannot ride page.route: AudioWorklet.addModule
    // fetches bypass Playwright interception (verified 2026-08-26 — route
    // never fires, worklet load aborts). Hand it to the page as a data URL
    // through this bridge function instead.
    const encSrc = readFileSync(join(assets, 'encoderWorker.min.js'), 'utf8');
    await page.exposeFunction('__humantyGetEncoderUrl', () =>
      `data:application/javascript;base64,${Buffer.from(encSrc).toString('base64')}`
    );

    // opus-recorder UMD first (defines window.Recorder), then the tap.
    await page.addScriptTag({
      content: readFileSync(join(assets, 'recorder.min.js'), 'utf8'),
    });
    // The tap script waits for media elements, builds the combined stream,
    // records with opus-recorder, and pushes base64 Ogg-Opus to Node.
    await page.addScriptTag({ content: PAGE_AUDIO_TAP });
    this.deps.log('[humanty] page audio capture requested');
  }

  /** Idempotent, never throws — safe to call from any teardown path (#593). */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    await this.deps.page.evaluate(async () => {
      const stopAudio = (globalThis as unknown as {
        __humanty_stopAudioCapture?: () => Promise<void>;
      }).__humanty_stopAudioCapture;
      await stopAudio?.();
    }).catch(() => { /* page may already be closed */ });
    this.endActivePaplay();
    this.closeSockets('bridge stop');
    this.deps.log('[humanty] stopped');
  }

  private closeSocket(ws: WebSocket | null, reason: string): void {
    if (!ws) return;
    this.expectedSocketCloses.add(ws);
    try {
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) {
        ws.close(1000, reason);
      }
    } catch { /* best-effort */ }
  }

  private closeSockets(reason: string): void {
    this.closeSocket(this.rt, reason);
    this.closeSocket(this.vid, reason);
    this.rt = null;
    this.vid = null;
  }

  private async rollbackStart(): Promise<void> {
    this.closeSockets('bridge start rollback');
    this.endActivePaplay();
  }

  // ────────────────── page hooks ──────────────────

  private async exposePageHooks(): Promise<void> {
    await this.deps.page.exposeFunction('__humanty_pushOpus', (b64: string) => {
      if (this.stopping) return;
      if (b64.length > MAX_PAGE_AUDIO_BASE64_CHARS) return;
      const ws = this.rt;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > MAX_REALTIME_BUFFERED_BYTES) return;
      try { ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 })); }
      catch (e) { this.deps.log(`[humanty] push audio failed: ${String(e)}`); }
    }).catch((e) => { this.deps.log(`[humanty] expose __humanty_pushOpus failed: ${String(e)}`); });
  }

  // ────────────────── realtime ws ──────────────────

  private createSocket(url: string, protocols: string[], maxPayload: number): WebSocket {
    return this.deps.createWebSocket?.(url, protocols, { maxPayload })
      ?? new WebSocket(url, protocols, { maxPayload });
  }

  private openSocket(
    kind: 'realtime' | 'video',
    url: string,
    protocols: string[],
    maxPayload: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = this.createSocket(url, protocols, maxPayload);
      if (kind === 'realtime') this.rt = ws;
      else this.vid = ws;

      let opened = false;
      let settled = false;
      const settleReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        settleReject(new Error(`${kind} ws open timed out`));
        this.expectedSocketCloses.add(ws);
        try { ws.terminate(); } catch { /* best-effort */ }
      }, this.deps.wsOpenTimeoutMs ?? DEFAULT_WS_OPEN_TIMEOUT_MS);
      timeout.unref?.();

      ws.on('open', () => {
        if (settled || this.stopping) return;
        opened = true;
        settled = true;
        clearTimeout(timeout);
        if (kind === 'realtime') {
          this.sendSessionUpdate();
          this.deps.log('[humanty] /v1/realtime open');
        } else {
          this.deps.log('[humanty] /v1/video/stream open');
        }
        resolve();
      });
      ws.on('message', (data, isBinary) => {
        if (kind === 'realtime') {
          if (!isBinary) this.handleRealtimeMessage(String(data));
        } else if (!isBinary) {
          this.handleVideoControl(String(data));
        } else {
          this.handleMuxedFrame(data as Buffer);
        }
      });
      ws.on('close', (code) => {
        if (kind === 'realtime' && this.rt === ws) this.rt = null;
        if (kind === 'video' && this.vid === ws) this.vid = null;
        if (!opened) settleReject(new Error(`${kind} ws closed before open: ${code}`));
        else if (!this.stopping && !this.expectedSocketCloses.has(ws)) {
          this.fail(`${kind} ws closed unexpectedly`);
        }
      });
      ws.on('error', (error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        if (!opened) settleReject(err);
        else this.deps.log(`[humanty] /v1/${kind} error: ${err.message}`);
      });
    });
  }

  private connectRealtime(): Promise<void> {
    const url = `${this.cfg.baseUrl}/v1/realtime`;
    return this.openSocket('realtime', url, ['realtime'], MAX_REALTIME_PAYLOAD_BYTES);
  }

  private sendSessionUpdate(): void {
    const session: Record<string, unknown> = {
      // Hand-off to humanty: the answer audio arrives muxed inside /v1/video/stream,
      // so raw TTS deltas are suppressed.
      use_lip_sync_audio: true,
    };
    if (this.cfg.voice) session.voice = this.cfg.voice;
    if (this.cfg.instructions) session.instructions = this.cfg.instructions;
    if (this.cfg.persona) session.video_name = this.cfg.persona;
    try { this.rt?.send(JSON.stringify({ type: 'session.update', session })); this.deps.log('[humanty] session.update sent'); }
    catch (e) { this.deps.log(`[humanty] session.update failed: ${String(e)}`); }
  }

  private handleRealtimeMessage(raw: string): void {
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(raw); } catch { return; }
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        this.bargeIn();
        break;
      case 'response.audio.delta':
        this.deps.log('[humanty] WARNING: response.audio.delta received with lipsync mode');
        break;
      case 'error':
        this.deps.log(`[humanty] realtime error event: ${raw.slice(0, 300)}`);
        break;
      default:
        break;
    }
  }

  // ────────────────── video ws (muxed avatar video + answer audio) ──────────────────

  private connectVideo(): Promise<void> {
    const url = `${this.cfg.baseUrl}/v1/video/stream`;
    const opening = this.openSocket('video', url, [], MAX_VIDEO_PAYLOAD_BYTES);
    if (this.vid) this.vid.binaryType = 'nodebuffer';
    return opening;
  }

  private handleVideoControl(raw: string): void {
    let ev: { type?: string; turn_id?: string; status?: string; message?: string };
    try { ev = JSON.parse(raw); } catch { return; }
    if (ev.type === 'unmute.video.turn_end' && typeof ev.turn_id === 'string' && ev.turn_id) {
      const turnId = ev.turn_id;
      let acknowledged = false;
      const acknowledge = (): void => {
        if (acknowledged) return;
        acknowledged = true;
        this.ackTurnPlayed(turnId);
      };
      try {
        if (this.deps.onTurnEnd) this.deps.onTurnEnd(acknowledge);
        else this.deps.log(`[humanty] turn ${turnId} has no camera paint fence; waiting for backend fallback`);
      } catch (error) {
        this.deps.log(`[humanty] turn ${turnId} paint fence failed: ${String(error)}`);
      }
      return;
    }
    if ((ev.status === 'ready' || ev.status === 'unavailable' || ev.status === 'disabled') && !this.readySignalled) {
      // Ready ⇒ avatar live; unavailable/disabled ⇒ proceed without video rather than
      // stalling the interview. Either way the meeting can start.
      this.readySignalled = true;
      this.deps.log(`[humanty] video stream status: ${ev.status}${ev.message ? ` (${ev.message})` : ''}`);
      try { this.deps.onReady?.(); } catch { /* listener must not break us */ }
    }
  }

  /**
   * Demux one v2/v3/v4 packet into H.264 bytes (to page) and Ogg-Opus bytes (to paplay).
   * Turn boundaries arrive as explicit text control messages; request IDs can span turns.
   */
  private handleMuxedFrame(buf: Buffer): void {
    const frame = parseMuxedFrame(buf);
    if (!frame) {
      this.deps.log('[humanty] unsupported or truncated mux packet, dropping');
      return;
    }

    if (frame.video.length > 0) {
      this.deps.onVideo?.(frame.video, frame.frameCount);
    }
    if (frame.audio.length > 0) this.feedOggOpus(frame.audio);
  }

  private ackTurnPlayed(turnId: string): void {
    try { this.vid?.send(JSON.stringify({ type: 'unmute.video.turn_played', turn_id: turnId })); }
    catch { /* best-effort */ }
  }

  // ────────────────── audio decode + paplay ──────────────────

  private endActivePaplay(): void {
    const decoder = this.ffmpegProc;
    const player = this.paplayProc;
    this.ffmpegProc = null;
    this.paplayProc = null;
    this.audioInputBlocked = false;
    for (const proc of [decoder, player]) {
      try { proc?.stdin?.destroy(); } catch { /* ignore */ }
      try { proc?.kill('SIGKILL'); } catch { /* ignore */ }
    }
    pactl('set-sink-mute tts_sink 1', this.deps.log);
    pactl('set-source-mute virtual_mic 1', this.deps.log);
  }

  private bargeIn(): void {
    this.deps.log('[humanty] BARGE-IN — interrupting playback');
    this.endActivePaplay();
    const ws = this.vid;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'unmute.video.interrupt' }));
        ws.send(JSON.stringify({ type: 'unmute.video.flush_queue' }));
      } catch { /* ignore */ }
    }
  }

  /**
   * Decode + play one Ogg-Opus run. ffmpeg does demux+decode in one child
   * (`-f ogg -i pipe:0` → s16le 24k mono raw) piped straight into paplay —
   * no node-side codec deps (gate:isolation-clean). Barge-in kills the pair;
   * the next audio chunk starts a fresh pipeline.
   */
  private feedOggOpus(audio: Buffer): void {
    if (this.stopping || audio.length === 0 || audio.length > MAX_OGG_CHUNK_BYTES) return;
    if (!this.ffmpegProc && !this.paplayProc) this.ensureDecoderPipeline();
    const dec = this.ffmpegProc, sink = this.paplayProc;
    if (this.audioInputBlocked || !dec?.stdin || dec.stdin.destroyed || !sink?.stdin || sink.stdin.destroyed) return;
    try { this.audioInputBlocked = !dec.stdin.write(audio); }
    catch { /* decoder mid-restart; drop */ }
  }

  private ensureDecoderPipeline(): void {
    if (this.ffmpegProc && this.paplayProc) return;
    // Unmute before the first playback burst (entrypoint leaves the chain muted).
    pactl('set-sink-mute tts_sink 0', this.deps.log);
    pactl('set-source-mute virtual_mic 0', this.deps.log);
    const log = (m: string): void => this.deps.log(m);

    // ffmpeg reads Ogg-Opus from stdin and writes raw PCM to paplay's stdin.
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'ogg', '-i', 'pipe:0',
      '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS),
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'ignore'] });
    const paplay = spawn('paplay', [
      '--raw', '--format=s16le',
      `--rate=${SAMPLE_RATE}`, `--channels=${CHANNELS}`,
      '--device=tts_sink',
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    ff.stdout.pipe(paplay.stdin);
    ff.stdout.once('data', () => log('[humanty] answer PCM decoded'));
    ff.stdin.on('error', () => { /* decoder exited between packets */ });
    ff.stdin.on('drain', () => { this.audioInputBlocked = false; });
    ff.on('error', (e) => log(`[humanty] ffmpeg spawn failed: ${e.message}`));
    paplay.on('error', (e) => log(`[humanty] paplay spawn failed: ${e.message}`));
    paplay.stderr?.on('data', (data: Buffer) => {
      const message = data.toString().trim();
      if (message) log(`[humanty] paplay: ${message.slice(0, 300)}`);
    });
    ff.on('exit', () => {
      if (this.ffmpegProc === ff) {
        this.ffmpegProc = null;
        this.audioInputBlocked = false;
      }
      try { paplay.kill('SIGTERM'); } catch { /* ignore */ }
      this.paplayProc = null;
    });
    paplay.on('exit', (code, signal) => {
      if (!this.stopping && code !== 0) {
        log(`[humanty] paplay exited code=${code} signal=${signal ?? ''}`);
      }
      if (this.paplayProc === paplay) this.paplayProc = null;
      if (this.ffmpegProc === ff) {
        try { ff.kill('SIGTERM'); } catch { /* ignore */ }
      }
    });
    this.ffmpegProc = ff;
    this.paplayProc = paplay;
  }

  // ────────────────── error path ──────────────────

  private fail(reason: string): void {
    if (this.stopping) return;
    this.deps.log(`[humanty] FAIL: ${reason}`);
    try { this.deps.onError?.(reason); } catch { /* ignore */ }
  }
}
