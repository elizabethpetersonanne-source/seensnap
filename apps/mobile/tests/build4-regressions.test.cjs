const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm'), ts=require('typescript'), path=require('node:path');
const React=require('react'), renderer=require('react-test-renderer'); global.IS_REACT_ACT_ENVIRONMENT=true;
function load(file,mocks={}) { const exports={}; vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,console,setTimeout,clearTimeout,setInterval,clearInterval,require:n=>n==='react'||n==='react/jsx-runtime'?require(n):mocks[n]});return exports; }
test('a bio-only edit does not resend an unchanged legacy username; saved response must match',()=>{
 const {profileChanges,profileMatches}=load('src/lib/profile-edit.ts');const old={username:'Legacy Name',display_name:'Liz',bio:'old'};
 const changes=profileChanges(old,{...old,bio:' new '});
 assert.equal(changes.username,undefined);assert.equal(changes.bio,'new');assert.equal(profileMatches(old,changes),false);assert.equal(profileMatches({...old,bio:'new'},changes),true);
 assert.equal(profileMatches({...old,bio:null},{bio:''}),true);
});
test('ambiguous diagonal and small drags do not commit; deliberate axes support all four directions',()=>{
 const {swipeDirection:s}=load('src/lib/swipe-gesture.ts');
 assert.equal(s(110,105,100,110),null);assert.equal(s(70,0,100,110),null);
 assert.equal(s(120,10,100,110),'right');assert.equal(s(-120,10,100,110),'left');assert.equal(s(10,-130,100,110),'up');assert.equal(s(10,130,100,110),'down');
});
test('hidden navigation routes retain their owning destination',()=>{
 const {activeTab}=load('src/lib/navigation-tabs.ts');assert.equal(activeTab('previews'),'swipe');assert.equal(activeTab('for-you'),'index');assert.equal(activeTab('search'),'index');assert.equal(activeTab('teams'),'teams');
});
test('sound intent survives player remounts but resets for another account and a new runtime',async()=>{
 let owner='alice',state,screen;
 const mocks={'@/lib/auth':{useAuth:()=>({user:{user_id:owner}})}};let module=load('src/lib/playback-preference.ts',mocks);
 function Harness(){state=module.usePlaybackMute();return null;}
 await React.act(async()=>{screen=renderer.create(React.createElement(Harness));});assert.equal(state[0],true);
 await React.act(async()=>state[1](false));assert.equal(state[0],false);
 await React.act(async()=>screen.unmount());await React.act(async()=>{screen=renderer.create(React.createElement(Harness));});assert.equal(state[0],false);
 owner='bob';await React.act(async()=>screen.update(React.createElement(Harness)));assert.equal(state[0],true);
 await React.act(async()=>state[1](false));await React.act(async()=>screen.unmount());module=load('src/lib/playback-preference.ts',mocks);
 await React.act(async()=>{screen=renderer.create(React.createElement(Harness));});assert.equal(state[0],true);await React.act(async()=>screen.unmount());
});
test('native fullscreen preserves position, proportions and mute; inactive previews destroy their player',async()=>{
 const seeks=[],full=[];let screen,dim={width:390,height:844};
 const YT=React.forwardRef((props,ref)=>{React.useImperativeHandle(ref,()=>({getCurrentTime:async()=>42,seekTo:s=>seeks.push(s)}));return React.createElement('YT',props);});
 const {default:Player}=load('src/components/youtube-player.native.tsx',{'react-native':{View:'View',Text:'Text',Pressable:'Pressable',Modal:'Modal',ActivityIndicator:'Spinner',useWindowDimensions:()=>dim},'react-native-safe-area-context':{useSafeAreaInsets:()=>({top:0,bottom:0,left:0,right:0})},'react-native-youtube-iframe':{default:YT},'@/lib/trailer-diagnostics':{trailerDiagnostic(){}},'@/constants/theme':{colors:{accent:'gold'}}});
 let props={videoKey:'one',isActive:true,muted:false,width:320,height:180,onFullScreenChange:f=>full.push(f)};
 await React.act(async()=>{screen=renderer.create(React.createElement(Player,props));});
 try {
  await React.act(async()=>screen.root.findByType('YT').props.onReady());assert.equal(screen.root.findByType('YT').props.play,true);
  await React.act(async()=>screen.root.findByProps({accessibilityLabel:'Expand trailer'}).props.onPress());assert.equal(full.at(-1),true);
  dim={width:844,height:390};await React.act(async()=>screen.update(React.createElement(Player,props)));await React.act(async()=>screen.root.findByType('YT').props.onReady());
  assert.equal(seeks.at(-1),42);let p=screen.root.findByType('YT').props;assert.ok(Math.abs(p.width/p.height-16/9)<1e-9);assert.equal(p.mute,false);
  await React.act(async()=>screen.root.findByProps({accessibilityLabel:'Exit fullscreen'}).props.onPress());await React.act(async()=>screen.root.findByType('YT').props.onReady());assert.equal(seeks.at(-1),42);
  props={...props,isActive:false};await React.act(async()=>screen.update(React.createElement(Player,props)));assert.equal(screen.root.findAllByType('YT').length,0);
 } finally {await React.act(async()=>screen.unmount());}
});
