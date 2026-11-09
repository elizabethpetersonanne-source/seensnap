const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), path = require('node:path');
function load(name) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/', name), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports });
  return exports;
}
const recovery=load('discovery-recovery.ts');
const id='f6815ade-5155-6783-7d61-0c79be50d36b';
const filter=recovery.discoveryFilterKey('show','Comedy','streaming');
const snapshot={version:1,filter,cursor:`${id}:2`,title_ids:[id],saved_at:10000,filters_hidden:true};
test('resume retains ordered title IDs and isolates account, surface and filter storage',()=>{
  assert.equal(recovery.parseDiscoverySnapshot(JSON.stringify(snapshot),filter,11000).title_ids[0],id);
  assert.notEqual(recovery.discoveryStorageKey('one','swipe'),recovery.discoveryStorageKey('two','swipe'));
  assert.notEqual(recovery.discoveryStorageKey('one','swipe'),recovery.discoveryStorageKey('one','preview'));
  assert.equal(recovery.parseDiscoverySnapshot(JSON.stringify(snapshot),recovery.discoveryFilterKey('movie','Comedy'),11000),null);
  assert.equal(recovery.parseDiscoverySnapshot(JSON.stringify(snapshot),recovery.discoveryFilterKey('show','Comedy','all'),11000),null);
});
test('corrupt, future, expired and oversized queues never bypass a fresh fetch',()=>{
  for(const raw of ['{','null',JSON.stringify({...snapshot,cursor:'bad'}),JSON.stringify({...snapshot,title_ids:['bad']}),JSON.stringify({...snapshot,title_ids:Array(101).fill(id)})])assert.equal(recovery.parseDiscoverySnapshot(raw,filter,11000),null);
  assert.equal(recovery.parseDiscoverySnapshot(JSON.stringify(snapshot),filter,9999),null);
  assert.equal(recovery.parseDiscoverySnapshot(JSON.stringify(snapshot),filter,10000+86400000),null);
});
test('gesture commits only the dominant direction and small movement remains neutral',()=>{
  const {swipeDirection}=load('swipe-gesture.ts');
  assert.equal(swipeDirection(0,0,80,80),null);assert.equal(swipeDirection(20,-30,80,80),null);
  assert.equal(swipeDirection(90,-140,80,80),'up');assert.equal(swipeDirection(-160,100,80,80),'left');
  assert.equal(swipeDirection(100,20,80,80),'right');assert.equal(swipeDirection(0,100,80,80),'down');
});
