const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), React = require('react'), renderer = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = React;
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
function load(file, overrides={}) {
  const native = Object.fromEntries(['ActivityIndicator','Image','Pressable','ScrollView','Text','TextInput','View'].map(n=>[n,n]));
  native.Keyboard={dismiss(){}}; native.StyleSheet={create:x=>x}; native.useWindowDimensions=()=>({width:320,height:568});
  const mocks={react:React,'react/jsx-runtime':require('react/jsx-runtime'),'react-native':native,
    '@/constants/theme':{colors:{},fonts:{},radii:{},spacing:{lg:16}},'@expo/vector-icons':{Ionicons:'Icon'},
    '@/components/scene-dna-badge':{SceneDnaBadge:'Badge'},...overrides};
  const exports={};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
  }).outputText,{exports,AbortController,setTimeout,clearTimeout,require:n=>{assert.ok(n in mocks,n);return mocks[n];}});
  return exports;
}

test('promoting a For You title moves its reason and actions; refresh preserves the selection',async()=>{
  const {DiscoverSection}=load('src/components/discover-section.tsx');
  const a={id:'a',title:'First',reason:'Because you rated A',poster_url:null,backdrop_url:null,year:2000};
  const b={...a,id:'b',title:'Second',reason:'Because you saved B'};
  const actions=[],opens=[]; let screen;
  let props={hero:a,four:[b],kicker:'FOR YOU',onPressTitle:t=>opens.push(t.id),onAction:(action,t)=>actions.push([action,t.id])};
  await act(async()=>{screen=renderer.create(React.createElement(DiscoverSection,props));});
  try {
    await act(async()=>screen.root.findByProps({accessibilityLabel:'Feature Second'}).props.onPress());
    assert.ok(screen.root.findAllByType('Text').some(n=>n.props.children===b.reason));
    assert.ok(!screen.root.findAllByType('Text').some(n=>n.props.children===a.reason));
    assert.equal(screen.root.findByType('Badge').props.titleId,'b');
    await act(async()=>screen.root.findByProps({accessibilityLabel:'Rate: Second'}).props.onPress());
    assert.deepEqual(actions,[['rate','b']]);
    await act(async()=>screen.root.findByProps({accessibilityLabel:'Open details for Second'}).props.onPress());
    assert.deepEqual(opens,['b']);
    props={...props,hero:b,four:[a]};
    await act(async()=>screen.update(React.createElement(DiscoverSection,props)));
    assert.equal(screen.root.findByType('Badge').props.titleId,'b');
  } finally {await act(async()=>screen.unmount());}
});

test('background related results cannot cross title/account or reappear after close; retry works',async()=>{
  let inputs={token:'alice',id:'first'},state,screen; const calls=[];
  const {useRelatedTitles}=load('src/lib/use-related-titles.ts',{'@/lib/api':{apiRequest:(url,options)=>{
    const d=deferred();calls.push({url,options,...d});return d.promise;
  }}});
  function Harness(){state=useRelatedTitles(inputs.token,inputs.id);return null;}
  async function update(next){inputs={...inputs,...next};await act(async()=>screen.update(React.createElement(Harness)));}
  await act(async()=>{screen=renderer.create(React.createElement(Harness));});
  try {
    assert.equal(state.loading,true);
    await update({token:'bob',id:'second'});
    assert.equal(calls[0].options.signal.aborted,true);
    await act(async()=>calls[0].resolve([{id:'stale',title:'Old',content_type:'movie'}]));
    assert.equal(state.items.length,0);
    await act(async()=>calls[1].reject(Error('network')));
    assert.equal(state.error,true);
    await act(async()=>state.retry());
    await act(async()=>calls[2].resolve([{id:'fresh',title:'New',content_type:'series',poster_url:null,release_date:'2000-01-01'}]));
    assert.equal(state.items[0].id,'fresh');assert.equal(state.items[0].mediaType,'tv');
    assert.equal(state.error,false);
    await update({id:null}); assert.equal(state.items.length,0);assert.equal(state.loading,false);
    assert.equal(calls[2].options.signal.aborted,true);
  } finally {await act(async()=>screen.unmount());}
});

test('title detail requests opt out of inline recommendations but keep lightweight prefetch',async()=>{
  const calls=[];
  const {fetchUniversalTitle,fetchUniversalTitleByTmdbId}=load('src/lib/universal-title.ts',{'@/lib/api':{apiRequest:async url=>{
    calls.push(url);return {id:'one',title:'First',content_type:'movie',genres:[],people:[],credits:{}};
  }}});
  await fetchUniversalTitle('test','one');
  await fetchUniversalTitle('test','one',null,{lightweight:true});
  await fetchUniversalTitleByTmdbId('test','tv',10);
  assert.deepEqual(calls,['/titles/one?include_related=false','/titles/one?enrich=false','/titles/by-tmdb/tv/10?include_related=false']);
});

test('onboarding search rates without requiring a rank, and a failed number-one save stays retryable',async()=>{
  let screen;const rated=[],writes=[];
  const {OnboardingTitleSearch}=load('src/components/onboarding-title-search.tsx',{
    '@/lib/auth':{useAuth:()=>({sessionToken:'new-viewer'})},
    '@/components/confirm-dialog':{ConfirmDialog:'ConfirmDialog'},
    '@/lib/api':{ApiError:Error,apiRequest:async(url,options)=>{
      if(!options.method)return [{id:'film',title:'Known film',content_type:'movie',poster_url:null}];
      writes.push(url);throw Error('offline');
    }},
  });
  await act(async()=>{screen=renderer.create(React.createElement(OnboardingTitleSearch,{onRate:t=>rated.push(t.id)}));});
  try {
    await act(async()=>screen.root.findByType('TextInput').props.onChangeText('Known'));
    await act(async()=>new Promise(resolve=>setTimeout(resolve,380)));
    await act(async()=>screen.root.findByProps({accessibilityLabel:'Rate Known film'}).props.onPress());
    assert.deepEqual(rated,['film']); assert.equal(writes.length,0);
    await act(async()=>screen.root.findByProps({accessibilityLabel:'Choose Known film as your number one'}).props.onPress());
    assert.equal(writes.length,0);
    await act(async()=>screen.root.findByType('ConfirmDialog').props.onConfirm());
    // onConfirm starts an async operation; flush its rejection and state updates.
    await act(async()=>{});
    assert.equal(screen.root.findByType('ConfirmDialog').props.visible,true);
    assert.match(screen.root.findByType('ConfirmDialog').props.message,/Could not save/);
    assert.equal(screen.root.findByType('ConfirmDialog').props.busy,false);
  } finally {await act(async()=>screen.unmount());}
});
