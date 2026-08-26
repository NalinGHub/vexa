/**
 * Humanty integration config — read from env, NEVER from invocation.v1.
 *
 * The sealed invocation.v1 contract is `additionalProperties:false`, and upstream's own
 * precedent for infrastructure config is env vars (TTS_SERVICE_URL in tts-playback.ts).
 * Every knob here is optional at parse time: when HUMANTY_BASE_URL is unset the whole
 * integration is OFF and the bot behaves exactly like stock @vexa/bot.
 *
 * HUMANTY_MODE=true is the master switch (kept from the 2026-05 prototype for operator
 * familiarity); HUMANTY_BASE_URL alone also enables it so a bare `docker run -e
 * HUMANTY_BASE_URL=…` works without remembering the second variable.
 */

export interface HumantyConfig {
  /** Master switch: wire the interviewer brain + avatar video into this bot. */
  enabled: boolean;
  /** Loopback base of humanty-backend inside the pod (ws:// URLs are derived). */
  baseUrl: string;
  /** LatentSync video asset name for the avatar ("persona"). */
  persona: string | null;
  /** Voice hint forwarded in session.update (backend resolves Qwen3 voices itself). */
  voice: string | null;
  /** LLM system prompt for the interviewer brain. */
  instructions: string | null;
  /**
   * How long to wait (ms) after admission for the backend's avatar render pipeline to be
   * ready before giving up on the "ready" handshake. The join still proceeds — a meeting
   * without the avatar visible beats failing the interview over it.
   */
  videoReadyTimeoutMs: number;
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function loadHumantyConfig(env: NodeJS.ProcessEnv = process.env): HumantyConfig {
  const mode = TRUE_VALUES.has((env.HUMANTY_MODE ?? '').trim().toLowerCase());
  const base = (env.HUMANTY_BASE_URL ?? '').trim();
  const enabled = mode || base !== '';
  return {
    enabled,
    baseUrl: base.replace(/\/$/, '') || 'ws://127.0.0.1:8000',
    persona: (env.HUMANTY_PERSONA ?? '').trim() || null,
    voice: (env.HUMANTY_VOICE ?? '').trim() || null,
    instructions: (env.HUMANTY_INSTRUCTIONS ?? '').trim() || null,
    videoReadyTimeoutMs: Number(env.HUMANTY_VIDEO_READY_TIMEOUT_MS ?? 90_000),
  };
}
