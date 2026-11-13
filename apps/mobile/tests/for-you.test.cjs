const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), React = require('react'), renderer = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = React;
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };

async function mount(respond) {
  let inputs = {token:'alice',media:'movie',focused:true}, current, screen;
  const exports = {}, listeners = new Set(), calls = [];
  const mocks = {
    react: React,
    '@react-navigation/native': { useFocusEffect: callback => React.useEffect(() => inputs.focused ? callback() : undefined, [callback,inputs.focused]) },
    '@/lib/api': { apiRequest: (url,options) => { calls.push({url,...options}); return respond(url,options); } },
    '@/lib/taste-events': { subscribeTasteChanges: callback => { listeners.add(callback); return () => listeners.delete(callback); } },
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/lib/use-for-you.ts'),'utf8'), {
    compilerOptions: {module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText, {exports,AbortController,require:name => { assert.ok(name in mocks,name); return mocks[name]; }});
  function Harness() { current=exports.useForYou(inputs.token,inputs.media); return null; }
  await act(async () => { screen=renderer.create(React.createElement(Harness)); });
  return {
    get state() { return current; }, calls,
    setResponder(fn) { respond=fn; },
    async update(values) { inputs={...inputs,...values}; await act(async () => screen.update(React.createElement(Harness))); },
    async changeTaste(token='alice') { await act(async () => { for(const callback of listeners) callback(token); }); },
    async close() { await act(async () => screen.unmount()); },
  };
}

test('a failed initial fetch is an error, and retry recovers existing-account recommendations',async () => {
  const h=await mount(async () => { throw Error('timeout'); });
  try {
    assert.match(h.state.error,/Couldn't load/); assert.equal(h.state.loading,false);
    h.setResponder(async () => [{title:{id:'one'}}]);
    await act(async () => h.state.refresh());
    assert.equal(h.state.items[0].title.id,'one'); assert.equal(h.state.error,null);
  } finally { await h.close(); }
});

test('confirmed picks survive a failed refresh, and accepted taste changes refresh again',async () => {
  const h=await mount(async () => [{title:{id:'saved-result'}}]);
  try {
    h.setResponder(async () => { throw Error('offline'); });
    await h.changeTaste();
    assert.equal(h.state.items[0].title.id,'saved-result'); assert.ok(h.state.error);
    const count=h.calls.length; await h.changeTaste('another-account'); assert.equal(h.calls.length,count);
    h.setResponder(async () => [{title:{id:'fresh-result'}}]);
    await h.changeTaste(); assert.equal(h.state.items[0].title.id,'fresh-result');
  } finally { await h.close(); }
});

test('late responses cannot restore another account or the previous media type',async () => {
  const old=deferred(), next=deferred(); let number=0;
  const h=await mount(() => ++number === 1 ? old.promise : next.promise);
  try {
    await h.update({token:'bob',media:'tv'});
    assert.equal(h.calls[0].signal.aborted,true); assert.match(h.calls[1].url,/preferred_type=show/);
    await act(async () => old.resolve([{title:{id:'alice-film'}}]));
    assert.equal(h.state.items.length,0); assert.equal(h.state.loading,true);
    await act(async () => next.resolve([{title:{id:'bob-series'}}]));
    assert.equal(h.state.items[0].title.id,'bob-series');
  } finally { await h.close(); }
});

test('returning to Discover refreshes, and a successful empty catalog is not a network error',async () => {
  const h=await mount(async () => []);
  try {
    assert.equal(h.state.items.length,0); assert.equal(h.state.error,null); assert.equal(h.state.loading,false);
    await h.update({focused:false}); const count=h.calls.length;
    await h.changeTaste(); assert.equal(h.calls.length,count);
    await h.update({focused:true}); assert.equal(h.calls.length,count+1);
  } finally { await h.close(); }
});
