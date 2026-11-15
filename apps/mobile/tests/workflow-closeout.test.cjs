const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), React = require('react'), renderer = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = React;
function load(file, mocks) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, AbortController, require: name => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    assert.ok(name in mocks, `Missing mock ${name}`); return mocks[name];
  } });
  return exports;
}
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
class ApiError extends Error { constructor(status) { super('Unavailable'); this.status=status; } }
const page = (start, count, total=105) => ({ owner_user_id:'owner', total, items: Array.from({length:count},(_,i)=>({title_id:`title-${start+i}`,position:start+i+1})) });
async function pagesHarness() {
  let focused=true,token='viewer',endpoint='/profiles/owner/favorites/ranked', state, screen;
  const calls=[];
  const {useAudiencePages}=load('src/lib/use-audience-pages.ts',{
    'expo-router':{useFocusEffect:callback=>React.useEffect(()=>focused?callback():undefined,[callback,focused])},
    './api':{ApiError,apiRequest:(url,options)=>{const d=deferred();calls.push({url,options,...d});return d.promise;}},
  });
  function Harness(){state=useAudiencePages(endpoint,token);return null;}
  const update=()=>act(async()=>screen.update(React.createElement(Harness)));
  await act(async()=>{screen=renderer.create(React.createElement(Harness));});
  return {calls,get state(){return state;},focus:async value=>{focused=value;await update();},account:async value=>{token=value;await update();},
    source:async value=>{endpoint=value;await update();},close:()=>act(async()=>screen.unmount())};
}

test('public rankings pass 100, preserve personal order, and revalidate loaded pages on return',async()=>{
  const h=await pagesHarness();
  try {
    await act(async()=>h.calls[0].resolve(page(0,40)));
    await act(async()=>{void h.state.more();void h.state.more();}); assert.equal(h.calls.length,2);
    await act(async()=>h.calls[1].resolve(page(40,40)));
    await act(async()=>{void h.state.more();});
    await act(async()=>h.calls[2].resolve(page(80,25)));
    assert.equal(h.state.data.items.length,105);assert.equal(h.state.data.items[104].position,105);assert.equal(h.state.nextOffset,null);
    await h.focus(false);await h.focus(true);assert.equal(h.state.data,null);
    await act(async()=>h.calls[3].resolve(page(0,40)));
    await act(async()=>h.calls[4].resolve(page(40,40)));
    await act(async()=>h.calls[5].resolve(page(80,25)));
    assert.equal(h.state.data.items.length,105);
  } finally {await h.close();}
});

test('revoked audience clears previously loaded content and late account replies cannot restore it',async()=>{
  const h=await pagesHarness();
  try {
    await act(async()=>h.calls[0].resolve(page(0,40)));
    await act(async()=>{void h.state.more();});
    await act(async()=>h.calls[1].reject(new ApiError(404)));
    assert.equal(h.state.data,null);assert.match(h.state.error,/no longer shared/);
    await act(async()=>h.state.refresh());
    await h.account('other');assert.equal(h.calls[2].options.signal.aborted,true);
    await act(async()=>h.calls[2].resolve(page(0,40)));assert.equal(h.state.data,null);
    await act(async()=>h.calls[3].reject(new ApiError(403)));assert.equal(h.state.data,null);
  } finally {await h.close();}
});

test('a failed return refresh hides old private content, while a failed later page has a retry',async()=>{
  const h=await pagesHarness();
  try {
    await act(async()=>h.calls[0].resolve(page(0,40)));
    await act(async()=>{void h.state.more();});await act(async()=>h.calls[1].reject(Error('offline')));
    assert.equal(h.state.data.items.length,40);
    await act(async()=>{void h.state.more();});assert.match(h.calls[2].url,/offset=40/);
    await act(async()=>h.calls[2].resolve(page(40,40)));
    await h.focus(false);await h.focus(true);
    await act(async()=>h.calls[3].reject(Error('offline')));assert.equal(h.state.data,null);
    await act(async()=>h.state.refresh());await act(async()=>h.calls[4].resolve(page(0,40)));
    await act(async()=>h.calls[5].resolve(page(40,40)));assert.equal(h.state.data.items.length,80);
  } finally {await h.close();}
});

test('list pagination follows server offsets and source changes cancel previous reads',async()=>{
  const h=await pagesHarness();
  try {
    await h.source('/lists/list-id');
    await act(async()=>h.calls[1].resolve({...page(0,2),next_offset:17}));assert.equal(h.state.nextOffset,17);
    await act(async()=>{void h.state.more();});assert.match(h.calls[2].url,/offset=17/);
    await h.source('/public/lists/share-token');assert.equal(h.calls[2].options.signal.aborted,true);
    await act(async()=>h.calls[2].resolve({...page(17,2),next_offset:null}));assert.equal(h.state.data,null);
    await act(async()=>h.calls[3].resolve({...page(0,0),next_offset:null}));assert.equal(h.state.data.items.length,0);
  } finally {await h.close();}
});

test('team page calls carry all-member filtering and cancellation on every page',async()=>{
  const calls=[],signal=new AbortController().signal;
  const {fetchTeamPage}=load('src/lib/team-home.ts',{'./api':{apiRequest:async(url,options)=>{calls.push({url,options});return {};}}});
  await fetchTeamPage('viewer','team','watched',0,{allMembers:true,signal});
  await fetchTeamPage('viewer','team','watched',40,{allMembers:true,signal});
  await fetchTeamPage('viewer','team','both_want_to_watch',0);
  assert.ok(calls.slice(0,2).every(call=>call.url.endsWith('all_members=true')&&call.options.signal===signal));
  assert.match(calls[1].url,/offset=40/);assert.match(calls[2].url,/all_members=false/);
});

test('profile refresh cannot retain old activity, rankings, or a late title response',async()=>{
  let token='viewer',owner='first',screen;
  const calls=[],details=[];
  const native=Object.fromEntries(['ActivityIndicator','FlatList','Image','Pressable','ScrollView','Text','View'].map(name=>[name,name]));
  native.StyleSheet={create:x=>x};native.useWindowDimensions=()=>({width:390,height:844});native.Share={share:async()=>{}};
  const mocks={
    'react-native':native,'expo-router':{useLocalSearchParams:()=>({userId:owner}),useRouter:()=>({push(){}}),useFocusEffect:cb=>React.useEffect(cb,[cb])},
    '@expo/vector-icons':{Ionicons:'Icon'},'react-native-safe-area-context':{SafeAreaView:'SafeAreaView',useSafeAreaInsets:()=>({top:0,bottom:0})},
    '@/constants/theme':{colors:{},fonts:{},radii:{},spacing:{}},'@/lib/share':{SHARE_BASE:'https://example.invalid'},
    '@/lib/auth':{useAuth:()=>({sessionToken:token,user:{user_id:token}})},'@/lib/analytics':{trackEvent(){}},
    '@/lib/api':{resolveMediaUrl:x=>x,apiRequest:(url,options)=>{const d=deferred();calls.push({url,options,...d});return d.promise;}},
    '@/lib/universal-title':{fetchUniversalTitle:(_token,id,_seed,options)=>{const d=deferred();details.push({id,options,...d});return d.promise;}},
  };
  for(const [file,name] of [['headers/app-header','AppHeader'],['protected-image','ProtectedImage'],['avatar','Avatar'],['compatibility-sheet','CompatibilitySheet'],['full-bleed-poster-section','FullBleedPosterSection'],['universal-title-modal','UniversalTitleModal']]) mocks[`@/components/${file}`]={[name]:name};
  const Component=load('app/profile/[userId].tsx',mocks).default;
  await act(async()=>{screen=renderer.create(React.createElement(Component));});
  const profile=id=>({user_id:id,display_name:id,username:id,taste_labels:[],favorite_genres:[],current_obsessions:[],top_posters:[]});
  try {
    await act(async()=>{calls[0].resolve(profile('first'));calls[1].resolve({items:[{title_id:'first-title'}]});calls[2].resolve([]);calls[3].resolve([{id:'event',title_id:'private-activity'}]);});
    const list=screen.root.findByType('FlatList');
    assert.ok(list.props.data.some(page=>page.key==='activity'));
    await act(async()=>{void list.props.renderItem({item:{key:'identity'},index:0}).props.onOpenTitle('first-title');});
    await act(async()=>screen.root.findByType('UniversalTitleModal').props.onClose());
    assert.equal(details[0].options.signal.aborted,true);
    await act(async()=>details[0].resolve({id:'old-title'}));
    assert.equal(screen.root.findByType('UniversalTitleModal').props.title,null);
    owner='second';await act(async()=>screen.update(React.createElement(Component)));
    assert.equal(screen.root.findAllByType('FlatList').length,0);
    await act(async()=>{calls[4].resolve(profile('second'));calls[5].reject(Error('offline'));calls[6].resolve([]);calls[7].reject(new ApiError(403));});
    assert.deepEqual(Array.from(screen.root.findByType('FlatList').props.data,page=>page.key),['identity','loop']);
    token='other-viewer';await act(async()=>screen.update(React.createElement(Component)));
    assert.equal(screen.root.findByType('AppHeader').props.title,'Profile');
    assert.equal(screen.root.findAllByType('FlatList').length,0);
  } finally {await act(async()=>screen.unmount());}
});
