# assets/ — runtime assets for @vexa/bot

Static files copied into the bot image and read at runtime (never imported by
TS).

| Dir | Purpose |
|---|---|
| `humanty-audio/` | opus-recorder UMD + emscripten encoder worker served into the meeting page by the humanty overlay's synthetic route (`/__humanty_audio/*`, see `src/humanty/README.md`). Vendored from humanty-backend `frontend/public/` (2026-05 prototype). |
