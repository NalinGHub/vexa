// Minimal: no vexa launch, plain playwright chromium + our exact route+recorder code
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const assets = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'humanty-audio');
const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext();
let hits = 0;
await ctx.route('**/__humanty_audio/*', async (route) => {
  hits++;
  const url = new URL(route.request().url());
  const filename = url.pathname.split('/').pop() || '';
  const body = readFileSync(join(assets, filename));
  await route.fulfill({ status: 200, contentType: 'application/javascript', body });
});
const p = await ctx.newPage();
p.on('console', m => console.log('[pg]', m.text().slice(0, 110)));
await p.goto('about:blank');
await p.exposeFunction('__push', () => {});
await p.setContent(`<audio id="a" src="data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="></audio>`);
await p.evaluate(readFileSync(join(assets, 'recorder.min.js'), 'utf8'));
const res = await p.evaluate(async () => {
  const w = window;
  const ctx = new AudioContext();
  const el = document.getElementById('a');
  el.loop = true;
  await el.play().catch(() => {});
  const src = ctx.createMediaElementSource(el);
  const dest = ctx.createMediaStreamDestination();
  src.connect(dest);
  const rec = new w.Recorder({
    mediaTrackConstraints: false, encoderPath: '/__humanty_audio/encoderWorker.min.js',
    bufferLength: 4096, encoderFrameSize: 20, encoderSampleRate: 24000,
    maxFramesPerPage: 2, numberOfChannels: 1, streamPages: true,
  });
  let chunks = 0; rec.ondataavailable = () => chunks++;
  try { await rec.start(dest.stream); } catch (e) { return 'start threw: ' + String(e).slice(0, 90); }
  await new Promise(r => setTimeout(r, 2500));
  return 'chunks=' + chunks;
});
console.log('RESULT:', res, 'routeHits=', hits);
await browser.close(); process.exit(0);
