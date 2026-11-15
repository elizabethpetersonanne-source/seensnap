const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), React = require('react'), renderer = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;
const {act} = React;
function load(file, mocks, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: name => { assert.ok(name in mocks, name); return mocks[name]; }, ...globals });
  return exports;
}

test('release preflight refuses missing identity, development auth, and insecure APIs', () => {
  const { checkRelease } = require('../scripts/check-native-release.cjs');
  assert.ok(checkRelease({}).length >= 3);
  const env = { EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: 'ios.apps.googleusercontent.com', SEENSNAP_EXPO_OWNER: 'confirmed-org', SEENSNAP_EAS_PROJECT_ID: '11111111-1111-4111-8111-111111111111', EXPO_PUBLIC_API_BASE_URL: 'https://api.example.invalid/api/v1' };
  assert.equal(checkRelease(env).length, 0);
  assert.ok(checkRelease({...env, EXPO_PUBLIC_ENABLE_DEV_AUTH: 'true'}).length);
  assert.ok(checkRelease({...env, EXPO_PUBLIC_API_BASE_URL: 'http://localhost:8000/api/v1'}).length);
});

test('native purchase identity stays bound throughout a purchase and account switch', async () => {
  const first = '11111111-1111-4111-8111-111111111111', second = '22222222-2222-4222-8222-222222222222';
  let uid, releasePurchase; const events = [];
  const sdk = { configure: x => { uid=x.appUserID; events.push(['configure',uid]); }, getAppUserID: async()=>uid,
    logIn: async id => { uid=id; events.push(['login',id]); },
    purchasePackage: async()=> { events.push(['purchase-start',uid]); await new Promise(resolve=>releasePurchase=resolve); events.push(['purchase-end',uid]); },
    restorePurchases: async()=> { events.push(['restore',uid]); },
  };
  const lib = load('src/lib/purchases.native.ts', {'expo-constants': {default:{appOwnership:'standalone'}}, 'react-native':{Platform:{OS:'ios'}}, 'react-native-purchases':{default:sdk}},
    {process:{env:{EXPO_PUBLIC_REVENUECAT_APPLE_KEY:'appl_test_public'}}});
  const buying=lib.buyPackage(first, {}); await new Promise(resolve=>setImmediate(resolve));
  const restoring=lib.restoreStorePurchases(second); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(uid,first); releasePurchase(); await Promise.all([buying,restoring]);
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [['configure',first],['purchase-start',first],['purchase-end',first],['login',second],['restore',second]]);
});

test('missing Apple SDK key cannot invoke purchase or restore', async () => {
  const lib = load('src/lib/purchases.native.ts', {'expo-constants':{default:{appOwnership:'standalone'}},'react-native':{Platform:{OS:'ios'}}}, {process:{env:{}}});
  assert.equal(lib.nativePurchasesAvailable,false);
  await assert.rejects(lib.restoreStorePurchases('11111111-1111-4111-8111-111111111111'), /not available/);
});

async function authHarness({ configured=true, result={type:'cancel'}, exchangeFails=false }={}) {
  let auth, screen; const requests=[];
  const hooks={};
  const authModule=load('src/lib/auth.tsx', {
    react:React, 'react/jsx-runtime': require('react/jsx-runtime'),
    'expo-apple-authentication':{}, 'expo-constants':{default:{appOwnership:'standalone'}},
    'expo-web-browser':{maybeCompleteAuthSession(){}},
    'expo-auth-session':{ResponseType:{IdToken:'id_token',Code:'code'}, exchangeCodeAsync:async()=>{if(exchangeFails)throw new Error('exchange failed');return {idToken:'verified-google-token'};}},
    'expo-auth-session/providers/google':{useAuthRequest:()=>[{redirectUri:'callback',codeVerifier:'verifier'}, null, async()=>result],discovery:{}},
    'react-native':{Platform:{OS:'ios'}},
    '@/lib/notifications':{deactivatePushToken:async()=>{}}, '@/lib/onboarding':{ONBOARDING_COMPLETED_KEY:'onboarding'},
    '@/lib/analytics':{setAnalyticsToken(){}}, '@/lib/taste-events':{publishTasteChange(){}}, '@/lib/title-state':{clearTitleStateCache(){}},
    '@/lib/recent-searches':{clearRecentSearches:async()=>{}}, '@/lib/session-storage':{getItem:async()=>null,setItem:async()=>{},deleteItem:async()=>{}},
    '@/lib/api':{apiRequest:async(p,o)=>{requests.push(p);return {access_token:'seen-token',user:{user_id:'user',email:'user@example.invalid'}};}},
  }, { __DEV__:false, process:{env: configured?{EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID:'ios.apps.googleusercontent.com'}:{} } });
  function Child(){auth=authModule.useAuth();return null;}
  await act(async()=>{screen=renderer.create(React.createElement(authModule.AuthProvider,null,React.createElement(Child)));});
  return { get auth(){return auth;}, requests, async close(){await act(async()=>screen.unmount());} };
}

test('release auth cannot fall back to dev or demo accounts',async()=>{
  const h=await authHarness({configured:false});
  try {
    await assert.rejects(h.auth.signInWithGoogle(),/not available/);
    await assert.rejects(h.auth.signInWithDevEmail('test@example.invalid'),/local development/);
    await act(async()=>{await assert.rejects(h.auth.signInDemo(),/local development/);});
    assert.equal(h.requests.length,0);
  } finally {await h.close();}
});

test('native Google code exchange errors reach the caller and clear loading',async()=>{
  const h=await authHarness({result:{type:'success',params:{code:'one-use-code'}},exchangeFails:true});
  try {
    await act(async()=>{await assert.rejects(h.auth.signInWithGoogle(),/exchange failed/);});
    assert.equal(h.auth.isLoading,false); assert.equal(h.auth.sessionToken,null);assert.equal(h.requests.length,0);
  } finally {await h.close();}
});

test('Google cancellation is quiet; successful code exchange uses the real endpoint',async()=>{
  let h=await authHarness();
  try {await act(async()=>h.auth.signInWithGoogle());assert.equal(h.requests.length,0);assert.equal(h.auth.isLoading,false);}finally{await h.close();}
  h=await authHarness({result:{type:'success',params:{code:'one-use-code'}}});
  try {await act(async()=>h.auth.signInWithGoogle());assert.deepEqual(h.requests,['/auth/google']);assert.equal(h.auth.sessionToken,'seen-token');}finally{await h.close();}
});
