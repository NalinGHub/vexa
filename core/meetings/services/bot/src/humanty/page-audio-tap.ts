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

  function collectMeetingAudioStream(audioCtx) {
    const dest = audioCtx.createMediaStreamDestination();
    const sources = [];
    const elems = Array.from(document.querySelectorAll('audio,video'));
    for (const el of elems) {
      if (!(el instanceof HTMLMediaElement)) continue;
      try {
        const src = audioCtx.createMediaElementSource(el);
        src.connect(dest);
        src.connect(audioCtx.destination);
        sources.push(src);
      } catch (e) { /* already wired elsewhere */ }
    }
    return { stream: dest.stream, sources };
  }

  function startCapture() {
    let audioCtx;
    try { audioCtx = new (w.AudioContext || w.webkitAudioContext)(); }
    catch (e) { console.warn('[humanty-page-audio] no AudioContext', e); return; }

    const { stream } = collectMeetingAudioStream(audioCtx);
    if (!stream.getAudioTracks().length) {
      console.log('[humanty-page-audio] no audio tracks yet, retrying...');
      setTimeout(() => { try { audioCtx.close(); } catch (e) {} startCapture(); }, 500);
      return;
    }

    const rec = new w.Recorder({
      mediaTrackConstraints: false,
      encoderPath: ENCODER_WORKER_URL,
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
      if (typeof rec.start === 'function' && rec.start.length >= 1) {
        rec.start(stream).catch((e) => console.warn('[humanty-page-audio] start failed', e));
      } else {
        rec._sourceNode = audioCtx.createMediaStreamSource(stream);
        rec.start();
      }
      w.__humanty_audioRec = rec;
      w.__humanty_audioCtx = audioCtx;
      console.log('[humanty-page-audio] capture started, sample_rate=', audioCtx.sampleRate);
    } catch (e) { console.warn('[humanty-page-audio] start threw', e); }
  }

  w.__humanty_audioInstalled = true;
  whenReady(startCapture);
})();
`;
