import assert from 'node:assert/strict';
import { createHumantyOverlay } from './index-humanty.js';

const requests: Array<Record<string, unknown>> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
  return new Response(null, { status: 204 });
}) as typeof fetch;

try {
  const overlay = createHumantyOverlay('google_meet', {
    HUMANTY_MODE: 'true',
    HUMANTY_BASE_URL: 'ws://127.0.0.1:8000',
  });
  assert(overlay);
  overlay.forwardLifecycle({ connection_id: 'conn-7', status: 'joining' });
  overlay.forwardLifecycle({ connection_id: 'conn-7', status: 'active' });
  await Promise.resolve();

  assert.deepEqual(requests, [
    { connection_id: 'conn-7', event_seq: 1, event: 'admitting' },
    { connection_id: 'conn-7', event_seq: 2, event: 'in_meeting' },
  ]);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('index-humanty.test.ts: PASS');
