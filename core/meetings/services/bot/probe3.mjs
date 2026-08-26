// Minimal: no vexa launch, plain playwright chromium + our exact route+recorder code
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const assets = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'humanty-audio');
const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext();
let hits = 0;
await ctx.route(/__humanty_audio\/.+$/, async (route) => {
  hits++;
  const url = new URL(route.request().url());
  const filename = url.pathname.split('/').pop() || '';
  const body = readFileSync(join(assets, filename));
  await route.fulfill({ status: 200, contentType: 'application/javascript', body });
});
const p = await ctx.newPage();
p.on('console', m => console.log('[pg]', m.text().slice(0, 110)));
await p.goto('http://127.0.0.1:8902/meeting', { waitUntil: 'domcontentloaded' });
await p.exposeFunction('__push', () => {});

const encSrc = readFileSync(join(assets, 'encoderWorker.min.js'), 'utf8');
await p.evaluate((s) => { window.__encUrl = URL.createObjectURL(new Blob([s], { type: 'application/javascript' })); }, encSrc);
await p.evaluate(readFileSync(join(assets, 'recorder.min.js'), 'utf8'));
const res = await p.evaluate(async () => {
  const w = window;
  const ctx = new AudioContext();
  const el = document.createElement('audio');
  el.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
  el.loop = true; document.body.appendChild(el);
  await el.play().catch(() => {});
  const src = ctx.createMediaElementSource(el);
  const dest = ctx.createMediaStreamDestination();
  src.connect(dest);
  const rec = new w.Recorder({
    mediaTrackConstraints: false, encoderPath: window.__encUrl,
    bufferLength: 4096, encoderFrameSize: 20, encoderSampleRate: 24000,
    maxFramesPerPage: 2, numberOfChannels: 1, streamPages: true,
    sourceNode: { context: ctx },
  });
  const sn = ctx.createMediaStreamSource(dest.stream);
  rec.initSourceNode = async () => { rec.sourceNode = sn; };
  let chunks = 0; rec.ondataavailable = () => chunks++;
  try { await rec.start(); } catch (e) { return 'start threw: ' + String(e).slice(0, 90); }
  await new Promise(r => setTimeout(r, 2500));
  return 'chunks=' + chunks;
});
console.log('RESULT:', res, 'routeHits=', hits);
await browser.close(); process.exit(0);
