import assert from 'node:assert/strict';
import type { Page } from 'playwright';
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

console.log('humanty-bridge.test.ts: PASS');
