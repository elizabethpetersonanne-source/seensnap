const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/concierge-requests.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
class ApiError extends Error { constructor(status) { super('transport'); this.status = status; } }
function client(apiRequest, saved = new Map()) {
  const exports = {};
  vm.runInNewContext(source, { exports, Date, Math, Map, Number, JSON, encodeURIComponent, require: (name) => {
    if (name === '@/lib/api') return { apiRequest, ApiError };
    if (name === '@/lib/session-storage') return {
      getItem: async (key) => saved.get(key) ?? null,
      setItem: async (key, value) => saved.set(key, value),
      deleteItem: async (key) => saved.delete(key),
    };
    throw new Error(name);
  } });
  return exports;
}
const result = (status, can_retry = false) => ({ status, can_retry, decision_id: 'decision', titles: [], constraints: null });

test('a lost POST response recovers its result without submitting another search', async () => {
  let posts = 0; const saved = new Map();
  const app = client(async (path, options) => {
    if (options.method === 'POST') { posts++; throw new Error('connection lost after commit'); }
    assert.match(path, /\/requests\//); return result('ready');
  }, saved);
  assert.equal((await app.runConciergeSearch('owner', 'secret-token', 'Comedy')).status, 'ready');
  assert.equal(posts, 1); assert.equal(saved.size, 0);
});

test('reload polls an in-flight receipt, then resumes its expired lease using the same key and list', async () => {
  const saved = new Map(); const keys = []; let expired = false;
  const transport = async (path, options) => {
    if (options.method === 'POST') {
      const body = JSON.parse(options.body); keys.push(body.idempotency_key);
      assert.equal(body.collection_list_id, 'private-list');
      return expired ? result('ready') : result('processing');
    }
    return result('processing', expired);
  };
  await client(transport, saved).runConciergeSearch('owner', 'token', 'My list', 'private-list');
  const reloaded = client(transport, saved);
  const draft = await reloaded.pendingConciergeSearch('owner');
  assert.equal(draft.collection_list_id, 'private-list');
  assert.equal((await reloaded.runConciergeSearch('owner', 'token', 'My list', 'private-list')).status, 'processing');
  assert.equal(keys.length, 1);
  expired = true;
  assert.equal((await reloaded.runConciergeSearch('owner', 'token', 'My list', 'private-list')).status, 'ready');
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
});

test('account and edited-request keys are isolated, with no token persisted', async () => {
  const saved = new Map(); const keys = [];
  const app = client(async (_, options) => {
    if (options.method === 'POST') keys.push(JSON.parse(options.body).idempotency_key);
    return result('error', true);
  }, saved);
  await app.runConciergeSearch('alice', 'very-secret-token', 'Comedy');
  assert.equal(await app.pendingConciergeSearch('bob'), null);
  await app.runConciergeSearch('bob', 'another-secret', 'Comedy');
  await app.runConciergeSearch('alice', 'very-secret-token', 'Thriller');
  assert.equal(new Set(keys).size, 3);
  assert.equal([...saved.values()].some((raw) => /secret|token/.test(raw)), false);
});
