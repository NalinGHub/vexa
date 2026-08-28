import assert from 'node:assert/strict';
import { createHumantyOverlay, startWithRetry } from './index-humanty.js';

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
  await overlay.forwardLifecycle({ connection_id: 'conn-7', status: 'joining' });
  await assert.rejects(
    overlay.forwardLifecycle({ connection_id: 'conn-7', status: 'active' }),
    /media bridge is not ready/,
  );
  await Promise.resolve();

  assert.equal(requests.some((request) => request.event === 'in_meeting'), false,
    'active must not become in_meeting before the bridge is ready');
  assert.deepEqual(requests.map((request) => request.event), ['admitting', 'error']);

  let attempts = 0;
  await startWithRetry(async () => {
    attempts++;
    if (attempts < 3) throw new Error('not ready');
  }, 3, 0);
  assert.equal(attempts, 3, 'startup waits through transient failures');

  attempts = 0;
  await assert.rejects(startWithRetry(async () => {
    attempts++;
    throw new Error('still unavailable');
  }, 3, 0), /still unavailable/);
  assert.equal(attempts, 3, 'startup rejects after the bounded retry budget');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('index-humanty.test.ts: PASS');
