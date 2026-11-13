const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), React = require('react');
const renderer = require('react-test-renderer');
const { createHash } = require('node:crypto');
global.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = React;
const root = path.join(__dirname, '..');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const items = (prefix = 'title') => Array.from({ length: 20 }, (_, i) => {
  const hex = createHash('md5').update(`${prefix}-${i}`).digest('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { title: { id, title: `${prefix} ${i}`, content_type: 'movie', genres: [] }, reason: 'Your taste' };
});

// Render the actual Swipe screen with controllable transport and animation.
// No live account, title state or remote service is changed by these tests.
async function mount({ width = 390, holdExitAnimation = false, repeatPage = false } = {}) {
  const patches = [];
  const requests = [], stateListeners = new Set(), hydration = [];
  let filter = { media_type: null, genre: null }, handlers, screen;
  let send = () => Promise.resolve({ swipe_id: 'receipt' });
  const pans = [];
  class Value {
    constructor(value) { this.value = value; }
    setValue(value) { this.value = value; }
    interpolate() { return 0; }
    stopAnimation() {}
  }
  class ValueXY extends Value {
    constructor() { super({ x: 0, y: 0 }); this.x = new Value(0); this.y = new Value(0); pans.push(this); }
    getTranslateTransform() { return []; }
  }
  const animation = (value, config) => ({ start(done) { value?.setValue(config?.toValue); if (!(holdExitAnimation && config?.duration === 180)) done?.({ finished: true }); }, stop() {} });
  const rn = {
    ActivityIndicator: 'ActivityIndicator', Alert: {}, Image: 'Image', Linking: {},
    Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View',
    Platform: { OS: 'web' }, useWindowDimensions: () => ({ width, height: 900 }),
    StyleSheet: { create: x => x, absoluteFillObject: {}, hairlineWidth: 1 },
    PanResponder: { create(config) { handlers = config; return { panHandlers: {} }; } },
    Animated: { Value, ValueXY, View: 'AnimatedView', timing: animation, spring: animation, parallel: () => animation() },
  };
  const api = {
    ApiError: class extends Error { constructor(message, status) { super(message); this.status = status; } },
    resolveMediaUrl: value => value, resolvedApiBaseUrl: 'https://test.invalid',
    apiRequest: (url, options = {}) => {
      requests.push({ url, options });
      if (url.startsWith('/titles/recommendations/feed')) {
        const continuation = url.includes('cursor=');
        return Promise.resolve({ session_id: '01234567-89ab-cdef-0123-456789abcdef', items: items(continuation && !repeatPage ? 'next-page' : filter.genre || 'title'), next_cursor: continuation && !repeatPage ? 'session:2' : 'session:1', has_more: true });
      }
      if (url === '/me/preferences') return Promise.resolve({ connected_streaming_services: [] });
      if (url === '/titles/swipes') return send(options);
      throw new Error(`Unexpected request: ${url}`);
    },
  };
  function load(file) {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText, { exports, require: mockedRequire, setTimeout, clearTimeout, URLSearchParams, AbortController, console, __DEV__: false });
    return exports;
  }
  function mockedRequire(name) {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name === 'react-native') return rn;
    if (name === 'react-native-safe-area-context') return { SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) };
    if (name === 'expo-router') return { router: {} };
    if (name === '@expo/vector-icons') return { Ionicons: 'Ionicons' };
    if (name === '@/constants/theme') return { colors: {}, fonts: {}, rules: {}, spacing: {} };
    if (name === '@/lib/api') return api;
    if (name === '@/lib/auth') return { useAuth: () => ({ sessionToken: 'test-token', user: { user_id: 'owner' } }) };
    if (name === '@/lib/swipe-gesture') return load('src/lib/swipe-gesture.ts');
    if (name === '@/lib/discovery-recovery') return load('src/lib/discovery-recovery.ts');
    if (name === '@/lib/discovery-filter') return { useDiscoveryFilter: () => [filter, next => { filter = next; }, true] };
    if (name === '@/lib/discovery-storage') return { restoreDiscovery: async () => null, saveDiscoverySnapshot() {} };
    if (name === '@/lib/universal-title') return { fetchUniversalTitle: (token, id, seed, options) => {
      const call = { id, options, ...deferred() }; hydration.push(call); return call.promise;
    } };
    if (name === '@/lib/backdrop-pool') return { useFallbackBackdrop: () => null };
    if (name === '@/lib/format') return { formatGenres: () => '' };
    if (name === '@/lib/analytics') return { trackEvent() {} };
    if (name === '@/lib/swipe-sfx') return { playSwipeSound() {} };
    if (name === '@/lib/title-state') return {
      subscribeTitleState(fn) { stateListeners.add(fn); return () => stateListeners.delete(fn); },
      patchTitleState(id, state) { patches.push({id, ...state}); for (const fn of stateListeners) fn({ title_id: id, ...state }); },
    };
    if (name === '@/components/rating-editor') return { RatingEditor: 'RatingEditor', subscribeRatingChanges: () => () => {} };
    if (name.startsWith('@/components/')) return new Proxy({}, { get: (_, key) => String(key) });
    if (name === '@/lib/backdrop') return { selectSafeBackdrop: () => null };
    if (name === '@/lib/streaming') return { getStreamingServiceMeta: () => null };
    if (name === '@/lib/watch-handoff') return {};
    throw new Error(`Unexpected import: ${name}`);
  }
  const Swipe = load('app/(tabs)/swipe.tsx').default;
  await act(async () => { screen = renderer.create(React.createElement(Swipe)); });
  const button = label => screen.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === label);
  return {
    screen, requests, hydration, patches, button, api, pan: pans[0], handlers: () => handlers,
    sendWith(fn) { send = fn; },
    async click(label) { const b = button(label); assert.ok(b, `Missing button: ${label}`); assert.ok(!b.props.disabled, `Disabled button: ${label}`); await act(async () => { b.props.onPress(); }); },
    async genre(genre) { await act(async () => { screen.root.findByType('CategoryChips').props.onChange({ media_type: null, genre }); }); },
    async close() { await act(async () => screen.unmount()); },
    swipes() { return requests.filter(r => r.url === '/titles/swipes'); },
  };
}

test('a slow swipe shows progress, blocks duplicate gestures, and advances exactly once', async () => {
  const h = await mount(), request = deferred(); h.sendWith(() => request.promise);
  try {
    await h.click('Pass this title');
    assert.equal(h.screen.root.findAllByProps({ accessibilityLabel: 'Saving swipe' }).length, 1);
    assert.equal(h.button('Pass this title').props.disabled, true);
    assert.equal(h.handlers().onMoveShouldSetPanResponder(null, { dx: 120, dy: 0 }), false);
    await act(async () => { h.handlers().onPanResponderRelease(null, { dx: 120, dy: 0 }); });
    assert.equal(h.swipes().length, 1);
    await act(async () => request.resolve({ swipe_id: 'receipt' }));
    assert.ok(h.button('Flip title 1 to details'));
    assert.equal(h.button('Pass this title').props.disabled, false);
  } finally { await h.close(); }
});

test('prefetch requests each upcoming title once as other details finish', async () => {
  const h = await mount();
  try {
    assert.equal(h.hydration.length, 3);
    assert.ok(h.hydration.every(call => call.options.lightweight));
    const value = { credits: { cast: [] }, streamingAvailability: [], description: 'Cached details' };
    await act(async () => h.hydration[0].resolve(value));
    assert.equal(h.hydration.length, 3, 'Completing one request must not re-request the other two');
    await act(async () => h.hydration[1].resolve(value));
    assert.equal(h.hydration.length, 3);
    await h.click('Pass this title');
    assert.equal(h.hydration.length, 4, 'Only the newly entering card needs a request');
    assert.equal(new Set(h.hydration.map(call => call.id)).size, 4);
  } finally { await h.close(); }
});

test('real UUID title and session IDs produce a key within the deployed API limit', async () => {
  const h = await mount();
  try {
    await h.click('Next Watch');
    const payload = JSON.parse(h.swipes()[0].options.body);
    assert.equal(payload.title_id.length, 36);
    assert.equal(payload.session_id.length, 36);
    assert.ok(payload.idempotency_key.length <= 80, 'SwipeRecordCreate and DiscoveryDecision allow at most 80 characters');
    assert.ok(h.button('Flip title 1 to details'));
  } finally { await h.close(); }
});

test('Retry swipe resends the same action, not a feed request or a new decision', async () => {
  const h = await mount(); h.sendWith(() => Promise.reject(new Error('timeout')));
  try {
    await h.click('Next Watch');
    assert.ok(h.button('Flip title 0 to details'));
    const feedCount = h.requests.filter(r => r.url.startsWith('/titles/recommendations/feed')).length;
    const original = h.swipes()[0].options.body;
    h.sendWith(() => Promise.resolve({ swipe_id: 'same-receipt' }));
    await h.click('Retry this swipe');
    assert.equal(h.swipes()[1].options.body, original);
    assert.equal(h.requests.filter(r => r.url.startsWith('/titles/recommendations/feed')).length, feedCount);
    assert.ok(h.button('Flip title 1 to details'));
    assert.equal(h.button('Retry this swipe'), undefined);
    // A successful retry must also unblock automatic queue continuation.
    for (let i = 0; i < 11; i++) await h.click('Pass this title');
    assert.ok(h.requests.filter(r => r.url.startsWith('/titles/recommendations/feed')).length > feedCount);
  } finally { await h.close(); }
});

test('an OS-cancelled drag recenters without saving or disabling the next swipe', async () => {
  const h = await mount();
  try {
    await act(async () => {
      h.handlers().onPanResponderMove(null, { dx: 100, dy: 35 });
      h.handlers().onPanResponderTerminate();
    });
    assert.equal(h.pan.value.x, 0); assert.equal(h.pan.value.y, 0);
    assert.equal(h.swipes().length, 0);
    await h.click('Pass this title');
    assert.ok(h.button('Flip title 1 to details'));
  } finally { await h.close(); }
});

test('changing filters releases the old lock; a late response cannot interrupt the new swipe', async () => {
  const h = await mount(), old = deferred(), next = deferred(); h.sendWith(() => old.promise);
  try {
    await h.click('Pass this title');
    const oldSignal = h.swipes()[0].options.signal;
    await h.genre('Comedy');
    assert.equal(oldSignal.aborted, true);
    assert.ok(h.button('Flip Comedy 0 to details'));
    h.sendWith(() => next.promise); await h.click('Pass this title');
    await act(async () => old.resolve({ swipe_id: 'old' }));
    assert.equal(h.button('Pass this title').props.disabled, true);
    assert.ok(h.button('Flip Comedy 0 to details'));
    await act(async () => next.resolve({ swipe_id: 'new' }));
    assert.ok(h.button('Flip Comedy 1 to details'));
  } finally { await h.close(); }
});

test('missing animation completion cannot leave the confirmed swipe locked', async () => {
  const h = await mount({ width: 1200, holdExitAnimation: true });
  try {
    await h.click('Pass this title');
    await act(async () => new Promise(resolve => setTimeout(resolve, 550)));
    assert.ok(h.button('Flip title 1 to details'));
    assert.equal(h.button('Pass this title').props.disabled, false);
  } finally { await h.close(); }
});

test('flipped details allow vertical scrolling and never commit a watched gesture', async () => {
  const h = await mount();
  try {
    await h.click('Flip title 0 to details');
    assert.equal(h.handlers().onMoveShouldSetPanResponder(null, { dx: 0, dy: 120 }), false);
    assert.ok(h.screen.root.findAllByType('AnimatedView').some(node => node.props.style?.some?.(style => style?.touchAction === 'pan-y')));
    await h.click('Back to poster');
    assert.equal(h.handlers().onMoveShouldSetPanResponder(null, { dx: 0, dy: 120 }), true);
    assert.equal(h.swipes().length, 0);
  } finally { await h.close(); }
});

test('a repeated feed page stops automatic retries and preserves the remaining cards', async () => {
  const h = await mount({ repeatPage: true });
  try {
    for (let i = 0; i < 12; i++) await h.click('Pass this title');
    assert.equal(h.requests.filter(r => r.url.startsWith('/titles/recommendations/feed')).length, 2);
    assert.ok(h.button('Flip title 12 to details'));
    assert.ok(h.screen.root.findAllByType('Text').some(node => typeof node.props.children === 'string' && node.props.children.includes("queue couldn't advance")));
  } finally { await h.close(); }
});


test('a confirmed right swipe broadcasts the saved state and advances to the next title', async () => {
  const h = await mount(); h.sendWith(() => Promise.resolve({ swipe_id: 'receipt', saved: true }));
  try {
    await h.click('Next Watch');
    assert.equal(h.patches.at(-1).saved, true);
    assert.ok(h.button('Flip title 1 to details'));
  } finally { await h.close(); }
});
