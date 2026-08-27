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
import { createVideoCarrier, PAGE_VIDEO_CARRIER, type VideoCarrier } from './video-carrier.js';

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
  /** Document-start canvas camera + WebCodecs decoder, installed before navigation. */
  readonly cameraInitScript: string;
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

  let bridge: HumantyBridge | null = null;
  let carrier: VideoCarrier | null = null;
  let page: BrowserSession['page'] | null = null;
  let inMeetingStarted = false;
  let stopped = false;

  /** Upstream joins with mic + camera off. Turn both on only after admission,
   *  then attach the page-audio tap to the stable in-meeting document. */
  async function startInMeetingMedia(livePage: import('playwright').Page): Promise<void> {
    try {
      const enabled = await livePage.evaluate(({ platform }) => {
        // Structural shapes only — this package compiles without DOM libs.
        const doc = (globalThis as unknown as {
          document?: {
            querySelectorAll(sel: string): ArrayLike<{
              click?(): void;
              getAttribute(name: string): string | null;
            }>;
          };
          __humanty_activateCamera?: () => Promise<number>;
        }).document;
        const root = globalThis as unknown as { __humanty_activateCamera?: () => Promise<number> };
        const buttons = Array.from(doc?.querySelectorAll('[role="button"],button') ?? []);
        let mic = false;
        let camera = false;
        for (const button of buttons) {
          const label = button.getAttribute('aria-label') ?? '';
          if (!mic && /turn on microphone|unmute microphone|microphone off/i.test(label)) {
            button.click?.();
            mic = true;
          }
          if (!camera && /turn on camera|start video|camera off/i.test(label)) {
            button.click?.();
            camera = true;
          }
        }
        return root.__humanty_activateCamera?.().then((replaced) => ({ mic, camera, replaced }))
          ?? Promise.resolve({ mic, camera, replaced: 0, platform });
      }, { platform });
      log(`[humanty] in-meeting media enabled (mic=${enabled.mic}, camera=${enabled.camera}, repaired_senders=${enabled.replaced})`);
    } catch (e) {
      log(`[humanty] in-meeting media enable failed (non-fatal): ${String(e)}`);
    }
    await bridge?.startPageAudioCapture();
  }

  const overlay: HumantyOverlay = {
    config: cfg,
    cameraInitScript: PAGE_VIDEO_CARRIER,

    async start(session: BrowserSession): Promise<void> {
      if (stopped) return;
      page = session.page;
      carrier = createVideoCarrier(session.page, log);
      bridge = new HumantyBridge(cfg, {
        page: session.page,
        log,
        onReady: () => log('[humanty] avatar pipeline ready'),
        onError: (msg) => log(`[humanty] degraded: ${msg} (interview continues audio-only)`),
        onVideo: (h264, frameCount) => carrier?.pushVideo(h264, frameCount),
        onTurnEnd: (acknowledge) => carrier?.tagTurnEnd(acknowledge),
      });
      await bridge.start();
    },

    forwardLifecycle(e: LifecycleEvent): void {
      if (e.status === 'active' && page && !inMeetingStarted) {
        inMeetingStarted = true;
        void startInMeetingMedia(page);
      }
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
      await carrier?.stop().catch(() => {});
    },
  };

  log(`[humanty] overlay enabled (base=${cfg.baseUrl}, persona=${cfg.persona ?? 'default'})`);
  return overlay;
}

export { loadHumantyConfig };
export type { Invocation };
