# humanty-audio/ — opus-recorder bundle (vendored)

`recorder.min.js` (opus-recorder 8.0.5 UMD) and `encoderWorker.min.js`
(emscripten Opus encoder + AudioWorklet). Copied verbatim from the humanty
prototype (`humanty-backend/frontend/public/`, vendored 2026-05).

Served into the live meeting page by `src/humanty/humanty-bridge.ts`'s
synthetic route at `/__humanty_audio/*`. Do not modify — regenerate from
upstream opus-recorder when upgrading.
