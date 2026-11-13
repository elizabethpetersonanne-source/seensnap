const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), React = require('react'), renderer = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = React;
const preferences = { profile_visibility: 'public', show_activity: true, show_teams: false, show_public_lists: true };
async function mount({ failLoad = false } = {}) {
  let screen, patch = async () => { throw new Error('offline'); };
  const exports = {};
  const native = Object.fromEntries(['ActivityIndicator','Pressable','ScrollView','Switch','Text','View'].map(x => [x, x]));
  native.StyleSheet = { create: x => x };
  const mocks = {
    react: React, 'react/jsx-runtime': require('react/jsx-runtime'), 'react-native': native,
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    '@expo/vector-icons': { Ionicons: 'Ionicons' },
    '@/components/headers/app-header': { AppHeader: 'AppHeader' },
    '@/constants/theme': { colors: {}, fonts: {}, radii: {}, spacing: {} },
    '@/lib/auth': { useAuth: () => ({ sessionToken: 'test' }) },
    '@/lib/api': { apiRequest: async (_, options) => {
      if (options.method === 'PATCH') return patch(JSON.parse(options.body));
      if (failLoad) throw new Error('offline');
      return preferences;
    } },
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../app/settings/privacy.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: name => { assert.ok(name in mocks, name); return mocks[name]; } });
  await act(async () => { screen = renderer.create(React.createElement(exports.default)); });
  return { screen, patchWith: fn => { patch = fn; }, async close() { await act(async () => screen.unmount()); } };
}
test('failed privacy save keeps the last confirmed setting and displays the failure', async () => {
  const h = await mount();
  try {
    await act(async () => { h.screen.root.findAllByType('Switch')[0].props.onValueChange(false); });
    assert.equal(h.screen.root.findAllByType('Switch')[0].props.value, true);
    assert.ok(JSON.stringify(h.screen.toJSON()).includes('Your change could not be confirmed'));
    h.patchWith(async update => ({ ...preferences, ...update }));
    await act(async () => { h.screen.root.findAllByType('Switch')[0].props.onValueChange(false); });
    assert.equal(h.screen.root.findAllByType('Switch')[0].props.value, false);
    assert.ok(!JSON.stringify(h.screen.toJSON()).includes('Show my Watch Teams'));
  } finally { await h.close(); }
});
test('failed initial load disables settings until a successful retry', async () => {
  const h = await mount({ failLoad: true });
  try {
    assert.ok(h.screen.root.findAllByType('Switch').every(node => node.props.disabled));
    assert.ok(JSON.stringify(h.screen.toJSON()).includes("Couldn't load privacy settings"));
  } finally { await h.close(); }
});
