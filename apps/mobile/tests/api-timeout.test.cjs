const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path'), ts = require('typescript');

function apiWith(fetch) {
  const exports = {}, notifications = [];
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/api.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, fetch, AbortController, Headers, FormData, URL, Error, setTimeout, clearTimeout,
    process: { env: { EXPO_PUBLIC_API_BASE_URL: 'https://test.invalid/api/v1' } },
    require: name => {
      if (name === 'expo-constants') return { default: {} };
      if (name === 'react-native') return { Platform: { OS: 'web' } };
      if (name === '@/lib/taste-events') return { affectsTaste: (_, method) => method === 'POST', publishTasteChange: token => notifications.push(token) };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return { ...exports, notifications };
}

function stalledBody(signal) {
  return new Promise((_, reject) => {
    const abort = () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

test('timeout covers a stalled success response body after headers arrive', { timeout: 1000 }, async () => {
  const api = apiWith(async (_, { signal }) => ({ ok: true, status: 200, json: () => stalledBody(signal) }));
  await assert.rejects(api.apiRequest('/titles/swipes', { method: 'POST', token: 'owner', timeoutMs: 20 }), /timed out/);
  assert.equal(api.notifications.length, 0);
});

test('timeout covers an error body and still applies when a caller provides a signal', { timeout: 1000 }, async () => {
  const caller = new AbortController();
  const api = apiWith(async (_, { signal }) => ({ ok: false, status: 503, text: () => stalledBody(signal) }));
  await assert.rejects(api.apiRequest('/titles/swipes', { signal: caller.signal, timeoutMs: 20 }), /timed out/);
  assert.equal(caller.signal.aborted, false);
});

test('caller cancellation reaches a body in flight and is not mislabeled as a timeout', { timeout: 1000 }, async () => {
  const caller = new AbortController();
  const api = apiWith(async (_, { signal }) => ({ ok: true, status: 200, json: () => stalledBody(signal) }));
  const request = api.apiRequest('/titles/swipes', { signal: caller.signal, timeoutMs: 500 });
  caller.abort();
  await assert.rejects(request, error => error.name === 'AbortError');
});

test('completed writes keep response data, empty responses and structured conflicts', async () => {
  const api = apiWith(async () => ({ ok: true, status: 200, json: async () => ({ swipe_id: 'receipt' }) }));
  assert.deepEqual(await api.apiRequest('/titles/swipes', { method: 'POST', token: 'owner' }), { swipe_id: 'receipt' });
  assert.deepEqual(api.notifications, ['owner']);
  const empty = apiWith(async () => ({ ok: true, status: 204 }));
  assert.equal(await empty.apiRequest('/titles/swipes/receipt', { method: 'DELETE' }), undefined);
  const conflict = apiWith(async () => ({ ok: false, status: 409, text: async () => '{"detail":{"error":"rating_conflict"}}' }));
  await assert.rejects(conflict.apiRequest('/titles/swipes'), error => error instanceof conflict.ApiError && error.status === 409 && error.detail.error === 'rating_conflict');
});
