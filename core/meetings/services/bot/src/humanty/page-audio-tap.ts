/**
 * page-audio-tap.ts — the meeting's ears for the interviewer brain.
 *
 * Injected into the live meeting page by HumantyBridge.startPageAudioCapture().
 * Waits for participant media elements, combines every <audio>/<video> stream
 * into one Web Audio graph, records 20 ms / 24 kHz mono Ogg-Opus with the
 * vendored opus-recorder bundle (served via the bridge's synthetic route), and
 * ships each chunk to Node through __humanty_pushOpus. Ported from the 2026-05
 * prototype's humanty-page-audio.ts.
 */
export const PAGE_AUDIO_TAP = String.raw`
(() => {
  'use strict';
  if (typeof window === 'undefined') return;
  const w = /** @type {any} */ (window);
  if (w.__humanty_audioInstalled) return;

  const ENCODER_WORKER_URL = '/__humanty_audio/encoderWorker.min.js';

  // opus-recorder UMD is injected before this script by the bridge.
  function whenReady(cb) {
    const start = performance.now();
    const tick = () => {
      if (typeof w.Recorder === 'function' && document.readyState !== 'loading') { cb(); return; }
      if (performance.now() - start > 30000) {
        console.warn('[humanty-page-audio] giving up waiting for Recorder/document');
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  }

  function base64Encode(u8) {
    const CHUNK = 0x8000;
    let s = '';
    for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    return btoa(s);
  }

  // Element→source bindings survive across retries (an <audio> can only ever
  // be bound to ONE AudioContext — rebinding throws InvalidAccessError).
  let sharedCtx = null;
  let sharedDest = null;
  const boundEls = new WeakSet();

  function collectMeetingAudioStream(audioCtx) {
    if (!sharedCtx || sharedCtx.state === 'closed') { sharedCtx = audioCtx; }
    if (!sharedDest) sharedDest = sharedCtx.createMediaStreamDestination();
    const elems = Array.from(document.querySelectorAll('audio,video'));
    for (const el of elems) {
      if (!(el instanceof HTMLMediaElement) || boundEls.has(el)) continue;
      try {
        const src = sharedCtx.createMediaElementSource(el);
        src.connect(sharedDest);
        src.connect(sharedCtx.destination);
        boundEls.add(el);
      } catch (e) { /* already wired elsewhere */ }
    }
    return { stream: sharedDest.stream, ctx: sharedCtx };
  }

  async function startCapture() {
    let audioCtx;
    try { audioCtx = new (w.AudioContext || w.webkitAudioContext)(); }
    catch (e) { console.warn('[humanty-page-audio] no AudioContext', e); return; }

    const { stream } = collectMeetingAudioStream(audioCtx);
    if (!stream.getAudioTracks().length) {
      console.log('[humanty-page-audio] no audio tracks yet, retrying...');
      setTimeout(() => { startCapture(); }, 500); // keep ctx alive — elements are bound to it
      return;
    }

    // Encoder worker rides a data: URL — AudioWorklet.addModule fetches bypass
    // Playwright route interception, so the synthetic route cannot serve it.
    let encUrl = '';
    try { encUrl = await w.__humantyGetEncoderUrl(); } catch (e) {}
    if (!encUrl) { console.warn('[humanty-page-audio] no encoder url'); return; }

    const rec = new w.Recorder({
      mediaTrackConstraints: false,
      encoderPath: encUrl,
      // Reuse OUR AudioContext inside the Recorder — its default ctor would
      // create a second context, and cross-context connects throw.
      sourceNode: { context: audioCtx },
      bufferLength: Math.round((960 * audioCtx.sampleRate) / 24000),
      encoderFrameSize: 20,
      encoderSampleRate: 24000,
      maxFramesPerPage: 2,
      numberOfChannels: 1,
      recordingGain: 1,
      resampleQuality: 3,
      encoderComplexity: 0,
      encoderApplication: 2049,
      streamPages: true,
    });

    rec.ondataavailable = (chunk) => {
      try {
        if (typeof w.__humanty_pushOpus === 'function') w.__humanty_pushOpus(base64Encode(chunk));
      } catch (e) { console.warn('[humanty-page-audio] push failed', e); }
    };

    try {
      // Feed the combined meeting stream without getUserMedia: override the
      // lib's initSourceNode to hand back our own MediaStreamAudioSourceNode.
      const sourceNode = (sharedCtx || audioCtx).createMediaStreamSource(stream);
      rec.initSourceNode = async () => { rec.sourceNode = sourceNode; };
      await rec.start();
      w.__humanty_audioRec = rec;
      w.__humanty_audioCtx = audioCtx;
      console.log('[humanty-page-audio] capture started, sample_rate=', audioCtx.sampleRate);
    } catch (e) { console.warn('[humanty-page-audio] start threw', e); }
  }

  w.__humanty_audioInstalled = true;
  whenReady(startCapture);
})();
`;
