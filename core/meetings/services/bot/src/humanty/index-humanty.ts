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

export async function startWithRetry(
  start: () => Promise<void>,
  attempts = 3,
  retryDelayMs = 1_000,
  onFailure?: (error: unknown, attempt: number) => void,
): Promise<void> {
  if (attempts < 1) throw new RangeError('attempts must be positive');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await start();
      return;
    } catch (error) {
      onFailure?.(error, attempt);
      if (attempt === attempts) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

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
  /** Wire the bridge against the live session. Rejects unless both WS connections are up. */
  start(session: BrowserSession): Promise<void>;
  /** Forward one lifecycle event after any required media activation completes. */
  forwardLifecycle(e: LifecycleEvent): Promise<void>;
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
  let bridgeReady = false;
  let inMeetingStarted = false;
  let stopped = false;
  let lifecycleEventSeq = 0;

  async function startBridgeWithRetry(): Promise<void> {
    const activeBridge = bridge;
    if (!activeBridge || stopped) throw new Error('humanty bridge unavailable during startup');
    await startWithRetry(
      () => activeBridge.start(),
      3,
      1_000,
      (error, attempt) => log(`[humanty] bridge start failed (attempt ${attempt}/3): ${String(error)}`),
    );
    if (stopped || activeBridge !== bridge) throw new Error('humanty bridge stopped during startup');
    bridgeReady = true;
  }

  /** Upstream joins with mic + camera off. Turn both on only after admission,
   *  then attach the page-audio tap to the stable in-meeting document. */
  async function startInMeetingMedia(livePage: import('playwright').Page): Promise<void> {
    if (!bridge || !bridgeReady) throw new Error('humanty bridge is not ready');
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
    if (!enabled.mic) throw new Error('meeting microphone could not be enabled');
    if (!enabled.camera && enabled.replaced === 0) {
      throw new Error('meeting camera could not be enabled or repaired');
    }
    await bridge.startPageAudioCapture();
    log(`[humanty] in-meeting media enabled (mic=${enabled.mic}, camera=${enabled.camera}, repaired_senders=${enabled.replaced})`);
  }

  async function postInternal(e: LifecycleEvent, event: string, message?: string): Promise<void> {
    if (!event || !cfg.baseUrl) return;
    const httpBase = cfg.baseUrl.replace(/^ws/, 'http');
    await fetch(`${httpBase}/v1/bot/_internal/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        connection_id: e.connection_id,
        event_seq: ++lifecycleEventSeq,
        event,
        message,
      }),
    }).catch(() => { /* process liveness remains the final backstop */ });
  }

  const overlay: HumantyOverlay = {
    config: cfg,
    cameraInitScript: PAGE_VIDEO_CARRIER,

    async start(session: BrowserSession): Promise<void> {
      if (stopped) throw new Error('humanty overlay is stopped');
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
      await startBridgeWithRetry();
    },

    async forwardLifecycle(e: LifecycleEvent): Promise<void> {
      if (e.status === 'active' && !inMeetingStarted) {
        try {
          if (!page || !bridgeReady) throw new Error('humanty media bridge is not ready');
          await startInMeetingMedia(page);
          inMeetingStarted = true;
        } catch (error) {
          await postInternal(e, 'error', `humanty media activation failed: ${String(error)}`);
          throw error;
        }
      }
      const { event, message } = lifecycleToInternal(e);
      await postInternal(e, event, message);
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
