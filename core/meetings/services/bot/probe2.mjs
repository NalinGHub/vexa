import { launchBrowser } from './dist/capture-bridge.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const assets = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'humanty-audio');
const s = await launchBrowser({ platform: 'google_meet', botName: 'T' });
const p = s.page;
let routeHits = 0;
await p.route('**/__humanty_audio/*', async (route) => {
  routeHits++;
  console.log('[route] hit', route.request().url().slice(-40));
  try {
    const url = new URL(route.request().url());
    const filename = url.pathname.split('/').pop() || '';
    const body = readFileSync(join(assets, filename));
    await route.fulfill({ status: 200, contentType: 'application/javascript', body });
    console.log('[route] fulfilled', filename, body.length, 'bytes');
  } catch (e) { console.log('[route] err', String(e).slice(0,60)); }
});
await p.goto('http://127.0.0.1:8902/meeting', { waitUntil: 'domcontentloaded' });
p.on('console', m => console.log('[pg]', m.text().slice(0, 110)));
await p.exposeFunction('__humanty_pushOpus', () => {});
await p.evaluate(readFileSync(join(assets, 'recorder.min.js'), 'utf8'));
const res = await p.evaluate(async () => {
  const w = window;
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const osc = ctx.createOscillator(); const g = ctx.createGain(); g.gain.value = 0.05;
  osc.connect(g); g.connect(dest); osc.start();
  const rec = new w.Recorder({
    mediaTrackConstraints: false, encoderPath: '/__humanty_audio/encoderWorker.min.js',
    bufferLength: 4096, encoderFrameSize: 20, encoderSampleRate: 24000,
    maxFramesPerPage: 2, numberOfChannels: 1, streamPages: true,
  });
  let chunks = 0; rec.ondataavailable = () => chunks++;
  try { await rec.start(dest.stream); } catch (e) { return 'start threw: ' + String(e).slice(0, 90); }
  await new Promise(r => setTimeout(r, 3000));
  return 'chunks=' + chunks;
});
console.log('RESULT:', res, 'routeHits=', routeHits);
await s.close(); process.exit(0);
