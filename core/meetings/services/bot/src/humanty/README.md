# humanty/ — the interviewer overlay for @vexa/bot

Bridges the stock bot to **humanty-backend** so a bot can join a meeting as an
AI interviewer with a lip-synced avatar. Everything here is OFF unless
`HUMANTY_MODE=true` (or `HUMANTY_BASE_URL` is set); unset env ⇒ the worker is
byte-equivalent to stock.

## Files

| File | Role |
|---|---|
| `config.ts` | Env-only config (the sealed `invocation.v1` stays untouched). |
| `humanty-bridge.ts` | `/v1/realtime` brain (opus in / barge-in) + `/v1/video/stream` demux (avatar H.264 + answer audio → `paplay` → `tts_sink`). |
| `video-carrier.ts` | H.264 → ffmpeg → y4m FIFO wired as Chromium's fake camera (`--use-file-for-fake-video-capture`). Replaces vexa's virtual camera removed in #1054. |
| `index-humanty.ts` | The overlay object + lifecycle tee → `POST /v1/bot/_internal/event` on humanty-backend. |

## Wire contract (humanty-backend side)

Realtime: subprotocol `realtime`; we send `session.update {use_lip_sync_audio,
voice?, instructions?, video_name?}` and stream `input_audio_buffer.append`
(base64 Ogg-Opus, 20 ms @ 24 kHz mono) captured from the meeting page.

Video: binary v2/v3 packets; H.264 Annex-B goes to the carrier, Ogg-Opus is
decoded to s16le 24 kHz mono and played through PulseAudio
`tts_sink → virtual_mic`. Turn boundaries (`req_id`) are ACKed via
`unmute.video.turn_played`; barge-in sends `unmute.video.interrupt`.

Lifecycle tee: every lifecycle.v1 transition is POSTed to
`<httpBase>/v1/bot/_internal/event` as `{event, message}` with event ∈
{admitting, in_meeting, leaving, error}.

## Env knobs

| Var | Default | Purpose |
|---|---|---|
| `HUMANTY_MODE` | off | Master switch (`true`/`1`). |
| `HUMANTY_BASE_URL` | `ws://127.0.0.1:8000` | humanty-backend loopback base. |
| `HUMANTY_PERSONA` | — | LatentSync video asset name (`session.video_name`). |
| `HUMANTY_VOICE` | — | Voice hint forwarded in `session.update`. |
| `HUMANTY_INSTRUCTIONS` | — | LLM system prompt for the interview. |
| `HUMANTY_VIDEO_READY_TIMEOUT_MS` | `90000` | Reserved: avatar readiness budget. |

## Upstream seams

The stock files carry ~15 marked lines total:

- `index.ts` — build overlay before browser launch; wrap lifecycle sink; start
  after session launch; stop during teardown.
- `capture-bridge.ts` — append the overlay's fake-camera arg to the launch args
  (Chromium pins that flag at startup).
