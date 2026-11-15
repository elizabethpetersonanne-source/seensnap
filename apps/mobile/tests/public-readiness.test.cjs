const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const ts=require('typescript'), React=require('react'), renderer=require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT=true; const {act}=React;
function load(file,mocks){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,setTimeout,clearTimeout,setInterval,clearInterval,console,require:name=>{if(name==='react'||name==='react/jsx-runtime')return require(name);assert.ok(name in mocks,name);return mocks[name];}});return exports;}
const pick=id=>({id,title:id,rank_label:'#1',media_type:'movie'});
const collections=()=>({ranked_favorites:[pick('one'),pick('two')],my_next_watch:[],favorites:[],watched:[],my_lists:[{id:'empty',name:'Empty collection',titles:[],total_count:0},{id:'full',name:'Long collection',titles:[pick('first')],total_count:2}],ranked_favorites_count:2});
test('My Picks has vertical sections, empty lists, promotion without rank mutation, and custom pagination',async()=>{
 const data=collections(),requests=[];
 const native=Object.fromEntries(['ActivityIndicator','Pressable','ScrollView','Text','View'].map(n=>[n,n]));native.StyleSheet={create:x=>x};native.useWindowDimensions=()=>({height:568,width:320});
 native.FlatList=props=>React.createElement('FlatList',props,props.data.map(item=>React.createElement(React.Fragment,{key:item.key},props.renderItem({item}))));
 const mocks={'react-native':native,'@expo/vector-icons':{Ionicons:'Icon'},'@react-navigation/native':{useFocusEffect:callback=>React.useEffect(callback,[callback])},'expo-router':{router:{push(){}}},'react-native-safe-area-context':{SafeAreaView:'SafeAreaView'},'@/constants/theme':{colors:{},fonts:{},spacing:{}},'@/lib/auth':{useAuth:()=>({sessionToken:'test'})},'@/lib/api':{apiRequest:async path=>{requests.push(path);return {items:[pick('last')],total:2};}},'@/lib/picks':{fetchPicksCollections:async()=>data},'@/lib/analytics':{trackEvent(){}},'@/lib/share':{shareTitle(){}},'@/lib/universal-title':{fetchUniversalTitle:async()=>({})},'@/lib/title-state':{subscribeTitleState:()=>()=>{}},'@/components/rating-editor':{RatingEditor:'RatingEditor',subscribeRatingChanges:()=>()=>{}},'@/components/state-views':{EmptyView:'EmptyView',LoadingView:'LoadingView'}};
 for(const[file,name]of[['add-to-team-sheet','AddToTeamSheet'],['headers/app-header','AppHeader'],['full-bleed-poster-section','FullBleedPosterSection'],['save-to-list-sheet','SaveToListSheet'],['universal-title-modal','UniversalTitleModal']])mocks['@/components/'+file]={[name]:name};
 const Screen=load('app/(tabs)/my-picks.tsx',mocks).default;let screen;await act(async()=>{screen=renderer.create(React.createElement(Screen));});
 try{const list=screen.root.findAllByType('FlatList').at(-1);assert.deepEqual(Array.from(list.props.data.slice(0,5),s=>s.key),['ranked_favorites','my_next_watch','favorites','watched','my_lists']);assert.ok(list.props.data.some(s=>s.listMeta?.id==='empty'));
 let poster=screen.root.findAllByType('FullBleedPosterSection')[0];await act(async()=>poster.props.onPressContinuation({id:'two'}));poster=screen.root.findAllByType('FullBleedPosterSection')[0];assert.equal(poster.props.hero.id,'two');assert.equal(data.ranked_favorites[0].id,'one');
 const custom=screen.root.findAllByType('FullBleedPosterSection')[1];await act(async()=>{custom.props.onEndReached();});assert.match(requests[0],/lists\/full\/titles\?limit=100&offset=1/);assert.equal(screen.root.findAllByType('FullBleedPosterSection')[1].props.four.length,2);
 }finally{await act(async()=>screen.unmount());}
});
test('list refresh reloads browsed tail and never turns server failure into empty collections',async()=>{
 class ApiError extends Error{constructor(status){super('HTTP');this.status=status;}}
 const previous=collections();previous.my_lists[1].titles=[pick('first'),pick('old-tail')];
 const {fetchPicksCollections}=load('src/lib/picks.ts',{'./api':{ApiError,apiRequest:async path=>path==='/me/picks/collections'?collections():{items:[pick('new-tail')]}}});
 assert.equal((await fetchPicksCollections('owner',previous)).my_lists[1].titles[1].id,'new-tail');
 const failing=load('src/lib/picks.ts',{'./api':{ApiError,apiRequest:async()=>{throw new ApiError(500);}}});await assert.rejects(()=>failing.fetchPicksCollections('owner'),e=>e.status===500);
});
test('native trailer retry retains playback position and switching titles resets it',async()=>{
 const seeks=[];const Player=React.forwardRef((props,ref)=>{React.useImperativeHandle(ref,()=>({getCurrentTime:async()=>42,seekTo:seconds=>seeks.push(seconds)}));return React.createElement('YT',props);});
 const {default:Screen}=load('src/components/youtube-player.native.tsx',{'react-native':{ActivityIndicator:'Spinner',Pressable:'Pressable',Text:'Text',View:'View'},'react-native-youtube-iframe':{default:Player},'@/lib/trailer-diagnostics':{trailerDiagnostic(){}},'@/lib/trailer-playback':{TrailerProgress:class{sample(){return null;}}},'@/constants/theme':{colors:{}}});
 const ref=React.createRef();let screen;const props={ref,videoKey:'first',isActive:true,muted:true,width:320,height:180};await act(async()=>{screen=renderer.create(React.createElement(Screen,props));});
 try{await act(async()=>ref.current.seekTo(42));await act(async()=>screen.root.findByType('YT').props.onError());await act(async()=>screen.root.findByType('Pressable').props.onPress());await act(async()=>screen.root.findByType('YT').props.onReady());assert.equal(seeks.at(-1),42);seeks.length=0;await act(async()=>screen.update(React.createElement(Screen,{...props,videoKey:'second'})));await act(async()=>screen.root.findByType('YT').props.onReady());assert.equal(seeks.length,0);}finally{await act(async()=>screen.unmount());}
});
