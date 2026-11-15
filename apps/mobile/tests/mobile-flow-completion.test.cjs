const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), React = require('react'), renderer = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = React;
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
function load(file, mocks) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, AbortController, setTimeout, clearTimeout, require: name => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    assert.ok(name in mocks, `Missing mock ${name}`); return mocks[name];
  } });
  return exports;
}
const title = id => ({ id, title: id, mediaType: 'movie', year: 2001, credits: { director: [], creator: [] }, imageGallery: [], genres: [], cast: [], creators: [], description: 'An actual synopsis.' });
async function modalHarness({ initial = title('first'), loading = false } = {}) {
  let token = 'owner', dimensions = { width: 390, height: 844, fontScale: 1 }, props, screen;
  const navigations = [], videos = [], opened = [];
  class Value { constructor(value) { this.value=value; } setValue(value) { this.value=value; } }
  const animation = () => ({ start: callback => callback?.({ finished: true }), stop() {} });
  const native = Object.fromEntries(['ActivityIndicator','Image','Modal','Pressable','ScrollView','Text','View'].map(n=>[n,n]));
  native.Animated = { Value, View:'AnimatedView', add:()=>0, timing:animation, spring:animation, parallel:animation, sequence:animation };
  native.StyleSheet={create:x=>x,absoluteFill:{position:'absolute'},absoluteFillObject:{position:'absolute'}};
  native.PanResponder={create:()=>({panHandlers:{}})}; native.Platform={OS:'web'}; native.useWindowDimensions=()=>dimensions;
  const mocks = {
    'react-native':native, '@expo/vector-icons':{Ionicons:'Icon'}, 'expo-router':{router:{push(){}}},
    'expo-web-browser':{WebBrowserPresentationStyle:{FULL_SCREEN:'full'},openBrowserAsync:async url=>opened.push(url)},
    'react-native-safe-area-context':{useSafeAreaInsets:()=>({top:20,bottom:34})},
    '@/constants/theme':{colors:{},fonts:{},radii:{},rules:{},spacing:{sm:8,md:16,lg:24}},
    '@/lib/auth':{useAuth:()=>({sessionToken:token,user:{user_id:token}})},
    '@/lib/analytics':{trackEvent(){}}, '@/lib/share':{shareTitle(){}}, '@/lib/watch-handoff':{},
    '@/lib/use-related-titles':{useRelatedTitles:(_,id)=>({items:id?[{id:'related',title:'Related',mediaType:'movie',year:2000}]:[],loading:false,error:false,retry(){}})},
    '@/lib/api':{resolveMediaUrl:x=>x,apiRequest:async(url,options)=>{
      if(url.endsWith('/videos')) { const d=deferred(); videos.push({url,options,...d}); return d.promise; }
      if(url.startsWith('/me/ratings/')) return {title_id:url.split('/').at(-1),score:null,version:0,watched_state:'want_to_watch'};
      if(url.endsWith('/watch-options')) return {content_id:url.split('/')[2],groups:{my_services:[],free:[],rent_buy:[],other_subscriptions:[]}};
      return [];
    }},
    '@/lib/universal-title':{fetchUniversalTitle:async(_,id,_seed,options)=>{ const d=deferred(); navigations.push({id,options,...d}); return d.promise; }},
    '@/components/rating-editor':{RatingBadge:'RatingBadge',RatingEditor:'RatingEditor',WatchStatusToggle:'WatchStatusToggle',subscribeRatingChanges:()=>()=>{}},
  };
  for(const [file,name] of [['scene-dna-badge','SceneDnaBadge'],['add-to-team-sheet','AddToTeamSheet'],['outline-action-rail','OutlineActionRail'],['save-to-list-sheet','SaveToListSheet'],['taste-signal','TasteSignal'],['share-composer-sheet','ShareComposerSheet'],['send-to-user-sheet','SendToUserSheet']]) mocks['@/components/'+file]={[name]:name};
  const {UniversalTitleModal}=load('src/components/universal-title-modal.tsx',mocks);
  props={visible:true,title:initial,loading,onClose(){}};
  await act(async()=>{screen=renderer.create(React.createElement(UniversalTitleModal,props));});
  return {screen,navigations,videos,opened,
    press:label=>act(async()=>screen.root.findByProps({accessibilityLabel:label}).props.onPress()),
    update:async changes=>{props={...props,...changes};await act(async()=>screen.update(React.createElement(UniversalTitleModal,props)));},
    rotate:async()=>{dimensions={...dimensions,width:844,height:390};await act(async()=>screen.update(React.createElement(UniversalTitleModal,props)));},
    account:async()=>{token='other';await act(async()=>screen.update(React.createElement(UniversalTitleModal,props)));},
    close:()=>act(async()=>screen.unmount()),
  };
}

test('title details distinguish pending, failed and ready without exposing stale actions',async()=>{
  const view=await modalHarness({initial:null,loading:true});
  try {
    const copy=()=>view.screen.root.findAllByType('Text').map(n=>n.props.children).join(' ');
    assert.match(copy(),/Loading title details/); assert.doesNotMatch(copy(),/unavailable|UNKNOWN|Series/);
    assert.equal(view.screen.root.findAllByType('OutlineActionRail').length,0);
    await view.update({loading:false}); assert.match(copy(),/Couldn't load this title/);
    await view.update({title:title('second')});
    assert.equal(view.screen.root.findByType('OutlineActionRail').props.titleId,'second');
    await view.update({loading:true}); assert.equal(view.screen.root.findAllByType('OutlineActionRail').length,0);
  } finally {await view.close();}
});

test('opening a related title resets the trailer and current rating; rotation uses current viewport',async()=>{
  const view=await modalHarness();
  try {
    await view.press('Play trailer');
    await act(async()=>view.videos[0].resolve([{key:'first-trailer'}]));
    assert.match(view.opened[0],/first-trailer/);
    await view.press('Open related title Related');
    assert.equal(view.screen.root.findAllByType('OutlineActionRail').length,0);
    await act(async()=>view.navigations[0].resolve(title('related')));
    const rail=view.screen.root.findByType('OutlineActionRail');
    assert.equal(rail.props.titleId,'related'); assert.equal(rail.props.ratingSnapshot.title_id,'related');
    await view.press('Play trailer');
    assert.match(view.videos[1].url,/titles\/related\/videos$/);
    await act(async()=>view.videos[1].resolve([{key:'second-trailer'}]));
    assert.match(view.opened[1],/second-trailer/);
    await view.rotate();
    assert.ok(view.screen.root.findAllByType('AnimatedView').some(n=>Array.isArray(n.props.style)&&n.props.style.some(s=>s?.height===390)));
  } finally {await view.close();}
});

test('late related and trailer replies cannot replace a new title or launch after closing',async()=>{
  const view=await modalHarness();
  try {
    await view.press('Open related title Related');
    await view.update({visible:false});
    assert.equal(view.navigations[0].options.signal.aborted,true);
    await view.update({visible:true,title:title('new-source')});
    await act(async()=>view.navigations[0].resolve(title('stale')));
    assert.equal(view.screen.root.findByType('OutlineActionRail').props.titleId,'new-source');
    await view.press('Play trailer'); await view.update({visible:false});
    await act(async()=>view.videos[0].resolve([{key:'late-trailer'}]));
    assert.equal(view.opened.length,0);
    await view.update({visible:true}); await view.press('Open related title Related');
    await view.account(); await act(async()=>view.navigations[1].resolve(title('other-owner-stale')));
    assert.equal(view.screen.root.findByType('OutlineActionRail').props.titleId,'new-source');
  } finally {await view.close();}
});

test('confirmed onboarding progress survives refresh failures and ignores old/account-switched responses',async()=>{
  const calls=[]; let token='first',enabled=true,state,screen;
  const {useOnboardingProgress}=load('src/lib/use-onboarding-progress.ts',{'@/lib/api':{apiRequest:(url,options)=>{
    const d=deferred();calls.push({url,options,...d});return d.promise;
  }}});
  function Harness(){state=useOnboardingProgress(token,enabled);return null;}
  const update=()=>act(async()=>screen.update(React.createElement(Harness)));
  const progress=count=>({rated_count:count,signal_count:count,target:5,completed:false});
  await act(async()=>{screen=renderer.create(React.createElement(Harness));});
  try {
    await act(async()=>{void state.refresh();});
    await act(async()=>calls[1].resolve(progress(4)));
    await act(async()=>calls[0].resolve(progress(0))); assert.equal(state.progress.rated_count,4);
    await act(async()=>{void state.refresh();}); await act(async()=>calls[2].reject(Error('offline')));
    assert.equal(state.error,true); assert.equal(state.progress.rated_count,4);
    await act(async()=>{void state.refresh();}); await act(async()=>calls[3].resolve(progress(5)));
    assert.equal(state.progress.rated_count,5); assert.equal(state.error,false);
    token='second';await update();assert.equal(state.progress,null);
    enabled=false;await update();assert.equal(calls[4].options.signal.aborted,true);
    await act(async()=>calls[4].resolve(progress(99)));assert.equal(state.progress,null);
  } finally {await act(async()=>screen.unmount());}
});
