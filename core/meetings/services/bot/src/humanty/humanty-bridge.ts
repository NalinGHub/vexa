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
 *   server → binary v2/v3 packets:
 *     v2: [1B 0x02][2B au_count][4B vlen][4B alen][1B rid_len][8B pts] + rid + H264 + OggOpus
 *     v3: same plus [8B batch_ts_us][4B frame_dur_us] before rid
 *   we demux: H.264 → onVideo callback (the fake-camera carrier);
 *             Ogg-Opus → ffmpeg → s16le 24k mono → paplay → tts_sink.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import type { Page } from 'playwright';
import type { HumantyConfig } from './config.js';

const SAMPLE_RATE = 24000;
const CHANNELS = 1;

function pactl(args: string, log: (m: string) => void): void {
  try {
    spawn('pactl', args.split(' '), { stdio: 'ignore' }).on('error', () => {});
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
  /** Receives every demuxed H.264 frame run (routed to the fake-camera carrier). */
  onVideo?: (h264: Buffer) => void;
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

  private currentReqId = '';
  private stopping = false;
  private readySignalled = false;
  private started = false;

  constructor(cfg: HumantyConfig, deps: HumantyBridgeDeps) {
    this.cfg = cfg;
    this.deps = deps;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.exposePageHooks();
    await this.connectRealtime();
    await this.connectVideo();
    this.deps.log('[humanty] both WS connections open');
  }

  /** Idempotent, never throws — safe to call from any teardown path (#593). */
  async stop(): Promise<void> {
    if (!this.started || this.stopping) return;
    this.stopping = true;
    this.endActivePaplay();
    for (const ws of [this.rt, this.vid]) {
      try { ws?.close(1000, 'bridge stop'); } catch { /* best-effort */ }
    }
    this.rt = null;
    this.vid = null;
    this.deps.log('[humanty] stopped');
  }

  // ────────────────── page hooks ──────────────────

  private async exposePageHooks(): Promise<void> {
    await this.deps.page.exposeFunction('__humanty_pushOpus', (b64: string) => {
      if (this.stopping) return;
      const ws = this.rt;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try { ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 })); }
      catch (e) { this.deps.log(`[humanty] push audio failed: ${String(e)}`); }
    }).catch((e) => { this.deps.log(`[humanty] expose __humanty_pushOpus failed: ${String(e)}`); });
  }

  // ────────────────── realtime ws ──────────────────

  private connectRealtime(): Promise<void> {
    const url = `${this.cfg.baseUrl}/v1/realtime`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, ['realtime']);
      let opened = false;
      ws.on('open', () => {
        opened = true;
        this.rt = ws;
        this.sendSessionUpdate();
        this.deps.log('[humanty] /v1/realtime open');
        resolve();
      });
      ws.on('message', (data, isBinary) => {
        if (!isBinary) this.handleRealtimeMessage(String(data));
      });
      ws.on('close', (code) => {
        if (this.rt === ws) this.rt = null;
        if (!opened) reject(new Error(`realtime ws closed before open: ${code}`));
        else if (!this.stopping) this.fail('realtime ws closed unexpectedly');
      });
      ws.on('error', (err) => {
        if (!opened) reject(err);
        else this.deps.log(`[humanty] /v1/realtime error: ${err.message}`);
      });
    });
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
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'nodebuffer';
      let opened = false;
      ws.on('open', () => {
        opened = true;
        this.vid = ws;
        this.deps.log('[humanty] /v1/video/stream open');
        resolve();
      });
      ws.on('message', (data, isBinary) => {
        if (!isBinary) { this.handleVideoControl(String(data)); return; }
        this.handleMuxedFrame(data as Buffer);
      });
      ws.on('close', (code) => {
        if (this.vid === ws) this.vid = null;
        if (!opened) reject(new Error(`video ws closed before open: ${code}`));
        else if (!this.stopping) this.fail('video ws closed unexpectedly');
      });
      ws.on('error', (err) => {
        if (!opened) reject(err);
        else this.deps.log(`[humanty] /v1/video/stream error: ${err.message}`);
      });
    });
  }

  private handleVideoControl(raw: string): void {
    let ev: { status?: string; message?: string };
    try { ev = JSON.parse(raw); } catch { return; }
    if ((ev.status === 'ready' || ev.status === 'unavailable' || ev.status === 'disabled') && !this.readySignalled) {
      // Ready ⇒ avatar live; unavailable/disabled ⇒ proceed without video rather than
      // stalling the interview. Either way the meeting can start.
      this.readySignalled = true;
      this.deps.log(`[humanty] video stream status: ${ev.status}${ev.message ? ` (${ev.message})` : ''}`);
      try { this.deps.onReady?.(); } catch { /* listener must not break us */ }
    }
  }

  /**
   * Demux one v2/v3 packet into H.264 bytes (→ page) and Ogg-Opus bytes (→ paplay).
   * See header comment for the wire layout. Turn boundaries are detected by req_id change
   * and ACKed so the backend's queue keeps flowing (unmute.video.turn_played).
   */
  private handleMuxedFrame(buf: Buffer): void {
    if (buf.length < 20) return;
    const t = buf[0];
    if (t !== 0x02 && t !== 0x03) return;
    const v3 = t === 0x03;
    const headerFixed = v3 ? 32 : 20;
    if (buf.length < headerFixed) return;

    const vlen = buf.readUInt32BE(3);
    const alen = buf.readUInt32BE(7);
    const ridLen = buf[11];
    const headerSize = headerFixed + ridLen;
    if (buf.length < headerSize + vlen + alen) {
      this.deps.log('[humanty] truncated v2/v3 packet, dropping');
      return;
    }
    const rid = ridLen > 0 ? buf.subarray(headerFixed, headerFixed + ridLen).toString('utf8') : '';
    const videoBytes = buf.subarray(headerSize, headerSize + vlen);
    const audioBytes = buf.subarray(headerSize + vlen, headerSize + vlen + alen);

    if (rid && rid !== this.currentReqId) {
      const prev = this.currentReqId;
      this.currentReqId = rid;
      if (prev) this.ackTurnPlayed(prev);
    }

    if (vlen > 0) {
      this.deps.onVideo?.(videoBytes);
      void this.pushVideoToPage(videoBytes);
    }
    if (alen > 0) this.feedOggOpus(audioBytes);
  }

  private async pushVideoToPage(videoBytes: Buffer): Promise<void> {
    try {
      // Playwright serializes the typed array across the bridge as ArrayBuffer.
      await this.deps.page.evaluate((bytes: number[]) => {
        const w = globalThis as unknown as { __humanty_pushVideo?: (a: ArrayBuffer) => void };
        w.__humanty_pushVideo?.(new Uint8Array(bytes).buffer);
      }, Array.from(videoBytes));
    } catch (e) {
      // Page may be mid-navigation; tolerate transient failures.
      this.deps.log(`[humanty] pushVideoToPage err: ${String(e)}`);
    }
  }

  private ackTurnPlayed(turnId: string): void {
    try { this.vid?.send(JSON.stringify({ type: 'unmute.video.turn_played', turn_id: turnId })); }
    catch { /* best-effort */ }
  }

  // ────────────────── audio decode + paplay ──────────────────

  private endActivePaplay(): void {
    const proc = this.paplayProc;
    if (proc) {
      try { proc.stdin?.destroy(); } catch { /* ignore */ }
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      this.paplayProc = null;
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
    this.currentReqId = '';
  }

  /**
   * Decode + play one Ogg-Opus run. ffmpeg does demux+decode in one child
   * (`-f ogg -i pipe:0` → s16le 24k mono raw) piped straight into paplay —
   * no node-side codec deps (gate:isolation-clean). Barge-in kills the pair;
   * the next audio chunk starts a fresh pipeline.
   */
  private feedOggOpus(audio: Buffer): void {
    if (this.stopping || audio.length === 0) return;
    if (!this.ffmpegProc && !this.paplayProc) this.ensureDecoderPipeline();
    const dec = this.ffmpegProc, sink = this.paplayProc;
    if (!dec?.stdin || dec.stdin.destroyed || !sink?.stdin || sink.stdin.destroyed) return;
    try { dec.stdin.write(audio); } catch { /* decoder mid-restart; drop */ }
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
    ff.on('error', (e) => log(`[humanty] ffmpeg spawn failed: ${e.message}`));
    paplay.on('error', (e) => log(`[humanty] paplay spawn failed: ${e.message}`));
    paplay.stderr?.on('data', () => { /* noisy; failures surface as silence + exit */ });
    ff.on('exit', () => {
      if (this.ffmpegProc === ff) this.ffmpegProc = null;
      try { paplay.kill('SIGTERM'); } catch { /* ignore */ }
      this.paplayProc = null;
    });
    paplay.on('exit', () => {
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
