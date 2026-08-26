import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const p = await (await browser.newContext()).newPage();
await p.goto('http://127.0.0.1:8902/meeting');
const caps = await p.evaluate(() => ({
  hasMediaDevices: !!navigator.mediaDevices,
  hasGUM: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
  hasWasm: typeof WebAssembly !== 'undefined',
  hasAudioWorklet: !!(window.AudioContext || window.webkitAudioContext) &&
    !!(new (window.AudioContext||window.webkitAudioContext)().audioWorklet),
}));
console.log(JSON.stringify(caps));
await browser.close(); process.exit(0);
