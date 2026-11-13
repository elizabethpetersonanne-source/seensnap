const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), React = require('react'), renderer = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = React;
function load(file, overrides) {
  const exports = {};
  const native = Object.fromEntries(['ActivityIndicator','Pressable','ScrollView','Text','View','Image','TextInput','Modal'].map(name => [name, name]));
  native.StyleSheet = { create: x => x }; native.Keyboard = { dismiss() {} };
  native.useWindowDimensions = () => ({ width: 320, height: 568, fontScale: 1.5 });
  const mocks = { react: React, 'react/jsx-runtime': require('react/jsx-runtime'), 'react-native': native,
    '@expo/vector-icons': { Ionicons: 'Icon' }, '@/constants/theme': { colors: {}, fonts: {}, radii: {}, spacing: {}, rules: {} }, ...overrides };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: name => { assert.ok(name in mocks, name); return mocks[name]; } });
  return exports;
}
test('a suggestion starts a fresh Concierge search while a typed follow-up retains context', async () => {
  const calls = [];
  const { ConciergeComposer } = load('../src/components/concierge-composer.tsx', {
    '@/lib/api': { apiRequest: async () => ({ prompts: [{ id: 'list', label: 'From my saved list', prompt: 'Help me choose from one of my saved lists.' }] }) },
  });
  let screen;
  const props = { token: 'test', tier: 'premium', continuing: true, conversationVersion: 'a:1', onSubmit: async (...args) => { calls.push(args); } };
  await act(async () => { screen = renderer.create(React.createElement(ConciergeComposer, props)); });
  try {
    await act(async () => { screen.root.findByType('TextInput').props.onChangeText('Something shorter'); });
    await act(async () => { await screen.root.findByType('TextInput').props.onSubmitEditing(); });
    assert.equal(calls[0][1].newSearch, false);
    await act(async () => { screen.root.findAllByType('Pressable').find(n => n.props.accessibilityLabel === 'From my saved list').props.onPress(); });
    await act(async () => { await screen.root.findByType('TextInput').props.onSubmitEditing(); });
    assert.equal(calls[1][1].newSearch, true);
    assert.match(calls[1][0], /saved lists/);
    // Parent preserves the pending draft after a failed new search; the
    // old result is still visible, but Retry must not refine that old result.
    await act(async () => screen.update(React.createElement(ConciergeComposer, { ...props, draft: calls[1][0] })));
    await act(async () => { await screen.root.findByType('TextInput').props.onSubmitEditing(); });
    assert.equal(calls[2][1].newSearch, true);
  } finally { await act(async () => screen.unmount()); }
});
test('compact rating editor exposes all ten choices and does not write until Save', async () => {
  const writes = [], snapshot = { title_id: 'test-title', score: null, watched_state: 'want_to_watch', version: 3 };
  const { RatingEditor } = load('../src/components/rating-editor.tsx', {
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 20, bottom: 20 }) },
    '@/components/confirm-dialog': { ConfirmDialog: 'ConfirmDialog' },
    '@/lib/title-state': { patchTitleState() {} },
    '@/lib/api': { ApiError: Error, apiRequest: async (_, options) => {
      if (!options.method) return snapshot;
      writes.push(JSON.parse(options.body)); return { ...snapshot, score: 10, version: 4, watched_state: 'watched' };
    } },
  });
  let screen;
  await act(async () => { screen = renderer.create(React.createElement(RatingEditor, { visible: true, titleId: 'test-title', token: 'test', onClose() {} })); });
  try {
    const choices = screen.root.findAllByType('Pressable').filter(n => /^Rate \d+ out of 10$/.test(n.props.accessibilityLabel ?? ''));
    assert.equal(choices.length, 10); assert.equal(writes.length, 0);
    await act(async () => choices[9].props.onPress());
    assert.equal(writes.length, 0);
    const save = screen.root.findAllByType('Pressable').filter(n => n.findAllByType('Text').some(t => t.props.children === 'Save rating')).at(-1);
    await act(async () => save.props.onPress());
    assert.equal(writes[0].score, 10); assert.equal(writes[0].expected_version, 3);
    assert.equal(screen.root.findAllByType('ScrollView').length, 1);
  } finally { await act(async () => screen.unmount()); }
});
