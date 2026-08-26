/**
 * humanty/index.ts — the humanty OVERLAY, called from the stock composition root.
 *
 * NOT a main() clone: index.ts invokes `createHumantyOverlay()` at the marked seam
 * (right after the browser session launches), so every upstream change to the join /
 * capture / orchestrator flow flows into this integration automatically. Everything
 * humanty-specific lives here; the stock files carry only ~15 marked lines.
 *
 * The overlay owns:
 *   1. HumantyBridge  — /v1/realtime (interviewer brain) + /v1/video/stream
 *                       (avatar video with the answer audio muxed inside), loopback.
 *   2. VideoCarrier   — H.264 → ffmpeg → y4m FIFO wired as Chromium's fake camera
 *                       (upstream #1054 removed vexa's virtual camera; this replaces
 *                       it at the OS seam).
 *   3. Lifecycle tee  — forwards lifecycle events to humanty-backend's internal
 *                       event endpoint so /v1/bot/status tracks joining → active →
 *                       completed/failed without scraping bot stdout.
 */
import type { Invocation } from '../config.js';
import type { BrowserSession } from '../capture-bridge.js';
import type { LifecycleEvent } from '../contracts.js';
import { loadHumantyConfig, type HumantyConfig } from './config.js';
import { HumantyBridge } from './humanty-bridge.js';
import { createVideoCarrier, type VideoCarrier } from './video-carrier.js';

const log = (m: string): void => console.log(`[bot] ${m}`);

/** The subset of LifecycleEvent the pod's state machine keys on (see unmute/bot_control.py). */
function lifecycleToInternal(e: LifecycleEvent): { event: string; message?: string } {
  switch (e.status) {
    case 'joining':
    case 'awaiting_admission':
      return { event: 'admitting', message: e.reason };
    case 'active':
      return { event: 'in_meeting' };
    case 'completed':
      return { event: 'leaving' };
    case 'failed':
      return { event: 'error', message: e.reason ?? e.completion_reason };
    default:
      // needs_help etc. — informational only; the pod FSM has no slot for it.
      return { event: '', message: e.reason };
  }
}

export interface HumantyOverlay {
  readonly config: HumantyConfig;
  /** Value to append to the browser launch args (--use-file-for-fake-video-capture=…),
   *  or null when disabled. Read by index.ts BEFORE launchBrowser(). */
  readonly cameraArg: string | null;
  /** Wire the bridge against the live session. Resolves once both WS connections are up;
   *  never throws (a failed bridge degrades to a transcription-only bot, loudly logged). */
  start(session: BrowserSession): Promise<void>;
  /** Forward one lifecycle event to the pod's internal endpoint (best-effort). */
  forwardLifecycle(e: LifecycleEvent): void;
  /** Idempotent teardown — safe from any exit path (#593). */
  stop(): Promise<void>;
}

/** Build the overlay. Returns null when humanty mode is off — the single branch the
 *  stock composition root needs. `platform` selects the meeting-UI mic selector. */
export function createHumantyOverlay(platform: string, env: NodeJS.ProcessEnv = process.env): HumantyOverlay | null {
  const cfg = loadHumantyConfig(env);
  if (!cfg.enabled) return null;

  const carrier: VideoCarrier = createVideoCarrier(log);
  let bridge: HumantyBridge | null = null;
  let stopped = false;

  /** Unmute the meeting-UI mic ONCE after admission (upstream joins muted; vexa's
   *  per-speak unmute is act-driven which humanty bypasses). Between avatar turns the
   *  PulseAudio chain is level-muted, so the open mic only ever carries our bursts. */
  async function unmuteMeetingMic(page: import('playwright').Page): Promise<void> {
    try {
      await page.evaluate(({ platform }) => {
        // Structural shapes only — this package compiles without DOM libs.
        const doc = (globalThis as unknown as {
          document?: {
            querySelector(sel: string): { click(): void } | null;
            querySelectorAll(sel: string): ArrayLike<{ click?(): void; getAttribute(name: string): string | null }>;
          };
        }).document;
        const click = (sel: string): void => { doc?.querySelector(sel)?.click(); };
        if (platform === 'teams') click('#microphone-button');
        else if (platform === 'zoom') click('.join-audio-container__btn');
        else {
          // Google Meet / Jitsi: aria-label match ("microphone" / "Toggle mute audio").
          const btns = Array.from(doc?.querySelectorAll('[role="button"],button') ?? []);
          const btn = btns.find((b) => /microphone|mute audio/i.test(b.getAttribute('aria-label') ?? ''));
          btn?.click?.();
        }
      }, { platform });
      log('[humanty] meeting mic unmuted');
    } catch (e) {
      log(`[humanty] mic unmute failed (non-fatal): ${String(e)}`);
    }
  }

  const overlay: HumantyOverlay = {
    config: cfg,
    cameraArg: `--use-file-for-fake-video-capture=${carrier.captureArg}`,

    async start(session: BrowserSession): Promise<void> {
      if (stopped) return;
      bridge = new HumantyBridge(cfg, {
        page: session.page,
        log,
        onReady: () => log('[humanty] avatar pipeline ready'),
        onError: (msg) => log(`[humanty] degraded: ${msg} (interview continues audio-only)`),
        // Demuxed avatar video → the fake-camera carrier (Chromium reads it as the cam).
        onVideo: (h264) => carrier.pushVideo(h264),
      });
      await bridge.start();
      await unmuteMeetingMic(session.page);
      // Ears: tap the live meeting page for audio → /v1/realtime (brain).
      await bridge.startPageAudioCapture();
    },

    forwardLifecycle(e: LifecycleEvent): void {
      const { event, message } = lifecycleToInternal(e);
      if (!event || !cfg.baseUrl) return;
      const httpBase = cfg.baseUrl.replace(/^ws/, 'http');
      fetch(`${httpBase}/v1/bot/_internal/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event, message }),
      }).catch(() => { /* best-effort: the pod also polls process liveness */ });
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await bridge?.stop().catch(() => {});
      await carrier.stop().catch(() => {});
    },
  };

  log(`[humanty] overlay enabled (base=${cfg.baseUrl}, persona=${cfg.persona ?? 'default'})`);
  return overlay;
}

export { loadHumantyConfig };
export type { Invocation };
