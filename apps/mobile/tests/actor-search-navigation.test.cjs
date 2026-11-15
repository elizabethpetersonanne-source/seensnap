const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const renderer = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = React;

async function renderSearch(file) {
  const navigation = [], titleRequests = [], timers = new Map();
  let timerId = 0, keyboardDismissals = 0;
  const actor = { entity_type: 'person', entity_id: '31', title: 'Tom Hanks',
    subtitle: 'Acting', route: '/person/31', source: 'tmdb' };
  const movie = { entity_type: 'movie', entity_id: 'local-title-uuid',
    title: 'Tom Hanks: The Nomad', route: '/titles/123', source: 'tmdb' };
  const results = { query: 'Tom Hanks', movies: [movie], series: [], people: [actor],
    collections: [], my_stuff: [] };
  const native = Object.fromEntries(['ActivityIndicator', 'Image', 'KeyboardAvoidingView',
    'Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map(name => [name, name]));
  native.StyleSheet = { create: styles => styles };
  native.Platform = { OS: 'ios' };
  native.Keyboard = { dismiss: () => keyboardDismissals++ };
  native.Animated = { Value: class { interpolate() { return 0; } },
    event: () => () => {}, ScrollView: 'ScrollView' };
  native.FlatList = props => React.createElement('FlatList', props, props.data.map((item, index) =>
    React.createElement(React.Fragment, { key: props.keyExtractor(item, index) }, props.renderItem({ item }))));
  const mocks = {
    react: React, 'react/jsx-runtime': require('react/jsx-runtime'), 'react-native': native,
    '@expo/vector-icons': { Ionicons: 'Icon' },
    '@react-navigation/native': { useFocusEffect: callback => React.useEffect(callback, [callback]) },
    'expo-router': { router: { push: route => navigation.push(route) } },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    '@/constants/theme': { colors: {}, fonts: {}, radii: {}, rules: {}, spacing: {} },
    '@/lib/countries': { COUNTRIES: [] },
    '@/lib/auth': { useAuth: () => ({ sessionToken: 'test' }) },
    '@/lib/api': { apiRequest: async url => url.startsWith('/search/global') ? results
      : url.startsWith('/titles/trending') ? [] : { items: [], display_label: '' } },
    '@/lib/use-for-you': { useForYou: () => ({ items: [], loading: false }) },
    '@/lib/entitlement': { useEntitlement: () => null },
    '@/lib/backdrop-pool': { useCyclingBackdrop: () => null },
    '@/lib/concierge-requests': {},
    '@/lib/watch-handoff': {},
    '@/lib/analytics': { trackEvent() {} },
    '@/lib/recent-searches': { addRecentSearch: async () => {}, getRecentSearches: async () => [] },
    '@/lib/universal-title': { fetchUniversalTitle: async (_, id) => { titleRequests.push(id); return { id }; } },
  };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    require: name => {
      if (name.startsWith('@/components/')) return new Proxy({}, { get: (_, exportName) => exportName });
      assert.ok(name in mocks, `Missing mock: ${name}`); return mocks[name];
    },
  });
  let screen;
  await act(async () => { screen = renderer.create(React.createElement(exports.default)); });
  const input = () => screen.root.findByType('TextInput');
  await act(async () => { input().props.onFocus?.(); input().props.onChangeText('Tom Hanks'); });
  await act(async () => {
    const pending = [...timers.values()]; timers.clear();
    for (const callback of pending) await callback();
  });
  const pressResult = async title => {
    const row = screen.root.findAllByType('Pressable').find(node =>
      node.findAllByType('Text').some(text => text.props.children === title));
    assert.ok(row, `Visible result: ${title}`);
    await act(async () => row.props.onPress());
  };
  return { screen, input, pressResult, navigation, titleRequests,
    keyboardDismissals: () => keyboardDismissals,
    close: () => act(async () => screen.unmount()) };
}

for (const peopleTab of [false, true]) {
  test(`Discover ${peopleTab ? 'People' : 'All'} result opens the actor and retains the search`, async () => {
    const view = await renderSearch('app/(tabs)/index.tsx');
    try {
      if (peopleTab) {
        const tab = view.screen.root.findAllByType('Pressable').find(node =>
          node.findAllByType('Text').some(text => text.props.children === 'People'));
        await act(async () => tab.props.onPress());
      }
      await view.pressResult('Tom Hanks');
      const route = view.navigation[0];
      assert.equal(route.pathname, '/person/[tmdbId]');
      assert.equal(route.params.tmdbId, '31');
      assert.equal(view.keyboardDismissals(), 1);
      assert.equal(view.titleRequests.length, 0);
      // The underlying screen must remain intact when the person route is pushed.
      assert.equal(view.input().props.value, 'Tom Hanks');
      assert.equal(view.screen.root.findByType('FlatList').props.data.length, peopleTab ? 1 : 2);
      assert.ok(view.screen.root.findAllByType('Pressable').some(node => node.props.accessibilityLabel === 'Open Tom Hanks'));
    } finally { await view.close(); }
  });
}

test('Discover movie results still open the local title modal', async () => {
  const view = await renderSearch('app/(tabs)/index.tsx');
  try {
    await view.pressResult('Tom Hanks: The Nomad');
    assert.deepEqual(view.titleRequests, ['local-title-uuid']);
    assert.equal(view.navigation.length, 0);
    assert.equal(view.screen.root.findByType('UniversalTitleModal').props.visible, true);
    assert.equal(view.input().props.value, 'Tom Hanks');
  } finally { await view.close(); }
});

test('dedicated Search uses the same TMDB actor identity and retains its query', async () => {
  const view = await renderSearch('app/(tabs)/search.tsx');
  try {
    await view.pressResult('Tom Hanks');
    assert.equal(view.navigation[0], '/person/31');
    assert.equal(view.titleRequests.length, 0);
    assert.equal(view.input().props.value, 'Tom Hanks');
  } finally { await view.close(); }
});
