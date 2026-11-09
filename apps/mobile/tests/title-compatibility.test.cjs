const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), path = require('node:path');
function load(name, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/', name), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, setTimeout, require: name => { if (name in dependencies) return dependencies[name]; throw Error(name); } });
  return exports;
}
function setup(request) {
  const events = load('taste-events.ts');
  return { ...events, ...load('title-compatibility.ts', { '@/lib/api': { apiRequest: request }, '@/lib/taste-events': events }) };
}
test('coalesces same-owner badges and isolates account caches', async () => {
  const calls = [];
  const api = setup(async (_path, { token, body }) => {
    const ids = JSON.parse(body).title_ids; calls.push([token, ids]);
    return Object.fromEntries(ids.map(id => [id, { percentage: token === 'alice' ? 65 : 42 }]));
  });
  const result = await Promise.all([api.getTitleCompatibility('alice', 'one'), api.getTitleCompatibility('alice', 'two'), api.getTitleCompatibility('alice', 'one'), api.getTitleCompatibility('bob', 'one')]);
  assert.equal(calls.length, 2); assert.deepEqual(calls[0][1], ['one', 'two']);
  assert.equal(result[0].percentage, 65); assert.equal(result[3].percentage, 42);
  await api.getTitleCompatibility('alice', 'one'); assert.equal(calls.length, 2);
});
test('late reads after a confirmed rating change cannot re-enter the cache', async () => {
  let resolve, started; const waiting = new Promise(done => { started = done; });
  const api = setup(() => { started(); return new Promise(done => { resolve = done; }); });
  const pending = api.getTitleCompatibility('owner', 'title'); await waiting;
  api.publishTasteChange('owner'); resolve({ title: { percentage: 99 } });
  assert.equal(await pending, null);
});
test('logout discards queued reads and transient errors never become fake matches', async () => {
  let calls = 0;
  const api = setup(async () => { calls++; throw Error('offline'); });
  const pending = api.getTitleCompatibility('old-owner', 'title'); api.publishTasteChange(null);
  assert.equal(await pending, null); assert.equal(calls, 0);
  assert.equal(await api.getTitleCompatibility('new-owner', 'title'), null);
});
test('only accepted taste writes trigger invalidation, not compatibility reads or analytics', () => {
  const { affectsTaste, publishTasteChange, subscribeTasteChanges } = load('taste-events.ts');
  for (const path of ['/me/ratings/one', '/me/favorites/reorder', '/me/watchlist/lists/one/items/two', '/me/scene-dna/signals/one/disable', '/titles/swipes/one']) assert.equal(affectsTaste(path, 'DELETE'), true);
  for (const [path, method] of [['/me/title-compatibility', 'POST'], ['/events', 'POST'], ['/me/ratings/one', 'GET']]) assert.equal(affectsTaste(path, method), false);
  subscribeTasteChanges(() => { throw Error('unmounted'); });
  assert.doesNotThrow(() => publishTasteChange('owner'));
});
