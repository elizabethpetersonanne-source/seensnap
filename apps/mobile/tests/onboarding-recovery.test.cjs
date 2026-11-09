const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), path = require('node:path');
function load(name, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/', name), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require: name => { if (name in dependencies) return dependencies[name]; throw Error(name); } });
  return exports;
}
const { readLocalDraft, reconcileDraft, draftKey } = load('onboarding-recovery.ts');
const defaults = { step: 'welcome', display_name: 'Alex', username: '', country_code: 'CA', streaming_services: ['netflix'] };
const offline = { ...defaults, step: 'services', username: 'alex' };
test('offline changes resume on their original revision; a lost acknowledgement is not a conflict', () => {
  let result = reconcileDraft({ data: offline, base_version: 2, pending: true }, { data: defaults, version: 2, completed: false }, defaults);
  assert.equal(result.data.username, 'alex'); assert.equal(result.conflict, false);
  result = reconcileDraft({ data: offline, base_version: 2, pending: true }, { data: offline, version: 3, completed: false }, defaults);
  assert.equal(result.conflict, false);
  assert.equal(draftKey({ ...offline, streaming_services: ['netflix', 'hulu'] }), draftKey({ ...offline, streaming_services: ['hulu', 'netflix'] }));
});
test('another device edit or clear requires a choice and preserves the pending local draft', () => {
  for (const data of [defaults, null]) {
    const result = reconcileDraft({ data: offline, base_version: 2, pending: true }, { data, version: 3, completed: false }, defaults);
    assert.equal(result.conflict, true); assert.equal(result.data.username, 'alex');
  }
  assert.equal(reconcileDraft({ data: offline, base_version: null, pending: true }, { data: null, version: 0, completed: false }, defaults).conflict, false);
});
test('corrupt device data is ignored and legacy drafts preserve current country and services', () => {
  for (const raw of ['{', 'null', JSON.stringify({data:{...offline,streaming_services:'netflix'}}), JSON.stringify({data:{...offline,country_code:'__'}})]) assert.equal(readLocalDraft(raw, defaults), null);
  const old = readLocalDraft(JSON.stringify({step:'calibrate', displayName:'Alexandra', handle:'alex'}), defaults);
  assert.equal(old.data.country_code, 'CA'); assert.equal(old.data.streaming_services[0], 'netflix'); assert.equal(old.data.step, 'calibrate');
  assert.equal(reconcileDraft({data:offline,base_version:2,pending:false},{data:null,version:3,completed:false},defaults).data.username,'');
});
test('accepted server completion opens the gate even when local storage fails', async () => {
  const { markOnboardingCompleted, subscribeOnboardingCompletion } = load('onboarding.ts', { '@/lib/session-storage': { setItem: async () => { throw Error('storage unavailable'); } } });
  const seen = []; subscribeOnboardingCompletion(() => { throw Error('a broken listener'); });
  subscribeOnboardingCompletion(id => seen.push(id));
  await markOnboardingCompleted('owner');
  assert.deepEqual(seen, ['owner']);
});
