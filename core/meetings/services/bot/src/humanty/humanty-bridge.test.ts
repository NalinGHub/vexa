import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Page } from 'playwright';
import WebSocket from 'ws';
import { HumantyBridge, parseMuxedFrame } from './humanty-bridge.js';
import type { HumantyConfig } from './config.js';

const cfg: HumantyConfig = {
  enabled: true,
  baseUrl: 'ws://127.0.0.1:8000',
  persona: null,
  voice: null,
  instructions: null,
  videoReadyTimeoutMs: 1_000,
};

function muxedV4(requestId: string, video: Buffer, audio: Buffer, metadata: object): Buffer {
  const rid = Buffer.from(requestId);
  const meta = Buffer.from(JSON.stringify(metadata));
  const header = Buffer.alloc(26);
  header[0] = 0x04;
  header.writeUInt16BE(2, 1);
  header.writeUInt32BE(video.length, 3);
  header.writeUInt32BE(audio.length, 7);
  header[11] = rid.length;
  header.writeBigUInt64BE(480n, 12);
  header.writeUInt32BE(40_000, 20);
  header.writeUInt16BE(meta.length, 24);
  return Buffer.concat([header, rid, video, audio, meta]);
}

const video = Buffer.from([0, 0, 0, 1, 0x65, 0xaa]);
const audio = Buffer.from('OggS');
const packet = muxedV4('req-shared', video, audio, { window_index: 7 });
const parsed = parseMuxedFrame(packet);
assert(parsed, 'v4 packet should parse');
assert.equal(parsed.frameCount, 2);
assert.equal(parsed.requestId, 'req-shared');
assert.deepEqual(parsed.video, video);
assert.deepEqual(parsed.audio, audio);
assert.equal(parseMuxedFrame(packet.subarray(0, packet.length - 1)), null,
  'truncated v4 metadata must reject the packet');

let deferredTurnAck: (() => void) | undefined;
const sent: string[] = [];
const bridge = new HumantyBridge(cfg, {
  page: {} as Page,
  onTurnEnd: (ack) => { deferredTurnAck = ack; },
  onVideo: () => {},
  log: () => {},
});
const internals = bridge as unknown as {
  vid: { send(data: string): void };
  handleVideoControl(raw: string): void;
  handleMuxedFrame(data: Buffer): void;
};
internals.vid = { send: (data) => sent.push(data) };

internals.handleMuxedFrame(muxedV4('req-shared', video, Buffer.alloc(0), {}));
internals.handleMuxedFrame(muxedV4('req-next', video, Buffer.alloc(0), {}));
assert.deepEqual(sent, [], 'request ID changes are not turn boundaries');

internals.handleVideoControl(JSON.stringify({
  type: 'unmute.video.turn_end',
  turn_id: 'turn-42',
}));
assert.equal(sent.length, 0, 'turn ACK must wait for carrier paint');
assert(deferredTurnAck, 'turn_end should register a carrier paint callback');
deferredTurnAck();
assert.deepEqual(JSON.parse(sent[0]), {
  type: 'unmute.video.turn_played',
  turn_id: 'turn-42',
});

let pushOpus: ((audio: string) => Promise<void>) | undefined;
const boundedSends: string[] = [];
const hookPage = {
  exposeFunction: async (name: string, callback: (audio: string) => Promise<void>) => {
    if (name === '__humanty_pushOpus') pushOpus = callback;
  },
} as unknown as Page;
const boundedBridge = new HumantyBridge(cfg, { page: hookPage, log: () => {} });
const boundedInternals = boundedBridge as unknown as {
  rt: { readyState: number; bufferedAmount: number; send(data: string): void };
  exposePageHooks(): Promise<void>;
};
await boundedInternals.exposePageHooks();
assert(pushOpus);
boundedInternals.rt = {
  readyState: WebSocket.OPEN,
  bufferedAmount: 2 * 1024 * 1024,
  send: (data) => boundedSends.push(data),
};
await pushOpus('T2dnUw==');
assert.equal(boundedSends.length, 0, 'page audio must drop while websocket output is backed up');
boundedInternals.rt.bufferedAmount = 0;
await pushOpus('A'.repeat(600 * 1024));
assert.equal(boundedSends.length, 0, 'oversized page audio must be rejected');
await pushOpus('T2dnUw==');
assert.equal(boundedSends.length, 1, 'bounded page audio should be forwarded');

let decoderWrites = 0;
const decoderBridge = new HumantyBridge(cfg, { page: {} as Page, log: () => {} });
const decoderInternals = decoderBridge as unknown as {
  ffmpegProc: { stdin: { destroyed: boolean; write(data: Buffer): boolean } };
  paplayProc: { stdin: { destroyed: boolean } };
  feedOggOpus(data: Buffer): void;
};
decoderInternals.ffmpegProc = {
  stdin: { destroyed: false, write: () => { decoderWrites++; return false; } },
};
decoderInternals.paplayProc = { stdin: { destroyed: false } };
decoderInternals.feedOggOpus(Buffer.from('first'));
decoderInternals.feedOggOpus(Buffer.from('second'));
assert.equal(decoderWrites, 1, 'decoder backpressure must drop later chunks until drain');

class FakeSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING;
  bufferedAmount = 0;
  binaryType = 'nodebuffer';
  closed = false;
  send(): void {}
  open(): void { this.readyState = WebSocket.OPEN; this.emit('open'); }
  close(code = 1000): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code);
  }
  terminate(): void { this.close(1006); }
}

const sockets: FakeSocket[] = [];
let rejectFirstVideo = true;
const retryBridge = new HumantyBridge(cfg, {
  page: { exposeFunction: async () => {}, evaluate: async () => {} } as unknown as Page,
  log: () => {},
  wsOpenTimeoutMs: 50,
  createWebSocket: (url) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    queueMicrotask(() => {
      if (url.endsWith('/v1/video/stream') && rejectFirstVideo) {
        rejectFirstVideo = false;
        socket.close(1006);
      } else {
        socket.open();
      }
    });
    return socket as unknown as WebSocket;
  },
});
await assert.rejects(retryBridge.start());
assert.equal(sockets[0].closed, true, 'failed video start must roll back realtime socket');
await retryBridge.start();
const socketCount = sockets.length;
await Promise.all([retryBridge.start(), retryBridge.start()]);
assert.equal(sockets.length, socketCount, 'concurrent/repeated starts must share one successful start');
await retryBridge.stop();

console.log('humanty-bridge.test.ts: PASS');
