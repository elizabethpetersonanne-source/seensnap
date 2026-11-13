const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), path = require('node:path');
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/trailer-playback.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: exportsObject });
const { TrailerPlayback } = exportsObject;
function setup() {
  const calls = [];
  const player = Object.fromEntries(['playVideo','pauseVideo','mute','unMute'].map(name => [name, () => calls.push(name)]));
  const playback = new TrailerPlayback(() => calls.push('fallback'), () => calls.push('blocked'));
  return { calls, player, playback };
}
test('active trailer starts when player becomes ready and inactive trailer pauses', () => {
  const { calls, player, playback } = setup();
  playback.update(true, true); assert.deepEqual(calls, []);
  playback.ready(player); assert.deepEqual(calls, ['mute','playVideo']);
  playback.update(false, true); assert.equal(calls.at(-1), 'pauseVideo');
  playback.update(true, true); assert.equal(calls.at(-1), 'playVideo');
});
test('blocked audible autoplay retries muted once, then offers a manual fallback', () => {
  const { calls, player, playback } = setup();
  playback.update(true, false); playback.ready(player); playback.blocked();
  assert.deepEqual(calls.slice(-3), ['mute','playVideo','fallback']);
  playback.blocked(); assert.equal(calls.at(-1), 'blocked');
  playback.update(false, true); const count = calls.length;
  playback.blocked(); assert.equal(calls.length, count);
});
test('sound changes reuse the existing player and its playback position', () => {
  const { calls, player, playback } = setup();
  playback.ready(player); playback.update(true, true); playback.update(true, false);
  assert.deepEqual(calls.slice(-2), ['unMute','playVideo']);
});
