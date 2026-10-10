const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { parseEvent, runHelper } = require('../dist/bridge');

function fixture(t, source) {
  const directory = mkdtempSync(join(tmpdir(), 'local-fm-test-'));
  const file = join(directory, 'helper');
  writeFileSync(file, `#!${process.execPath}\n${source}`, { mode: 0o755 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return file;
}
test('protocol rejects invalid events and preserves text literally', () => {
  assert.throws(() => parseEvent('{"type":"snapshot","text":1}'));
  assert.throws(() => parseEvent('null'));
  assert.equal(parseEvent('{"type":"snapshot","text":"<script>"}').text, '<script>');
});
test('streams full snapshots and sends structured history through stdin', async t => {
  const file = fixture(t, `let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const r=JSON.parse(input);console.log(JSON.stringify({type:'snapshot',text:r.history[0].text+r.prompt}));console.log('{"type":"done"}');});`);
  const events = [];
  await runHelper(file, { prompt: '世界', history: [{ role: 'user', text: 'こんにちは' }] }, e => events.push(e)).done;
  assert.deepEqual(events, [{ type: 'snapshot', text: 'こんにちは世界' }, { type: 'done' }]);
});
test('split JSON packets are joined', async t => {
  const file = fixture(t, `process.stdout.write('{"type":');setTimeout(()=>console.log('"ready"}'),20);`);
  await runHelper(file, undefined, () => {}).done;
});
test('reported unavailability is surfaced', async t => {
  const file = fixture(t, `console.log('{"type":"error","message":"モデルの準備中"}');`);
  await assert.rejects(runHelper(file, undefined, () => {}).done, /モデルの準備中/);
});
test('premature process exit does not count as success', async t => {
  const file = fixture(t, `console.log('{"type":"snapshot","text":"partial"}');`);
  await assert.rejects(runHelper(file, { prompt: 'test', history: [] }, () => {}).done, /終了/);
});
test('cancellation rejects and suppresses later events', async t => {
  const file = fixture(t, `setTimeout(()=>console.log('{"type":"ready"}'),200);`);
  const events = [];
  const job = runHelper(file, undefined, e => events.push(e));
  job.cancel(); await assert.rejects(job.done, /停止/); assert.deepEqual(events, []);
});
test('timeout kills a stalled helper', async t => {
  const file = fixture(t, `setTimeout(()=>{},10000);`);
  await assert.rejects(runHelper(file, undefined, () => {}, 30).done, /タイムアウト/);
});
test('missing executable reports launch failure', async () => {
  await assert.rejects(runHelper('/missing-local-fm-helper', undefined, () => {}).done, /起動|ENOENT/);
});

test('structured native error preserves safe category and numeric diagnostics', async t => {
  const file = fixture(t, `console.log('{"type":"error","message":"生成失敗","code":"generationFailed","nativeDomain":"ModelManagerServices.ModelManagerError","nativeCode":1008}');`);
  await assert.rejects(runHelper(file, undefined, () => {}).done, e => e.code === 'generationFailed' && e.nativeCode === 1008);
});
test('rejects diagnostic fields that could contain user data', () => {
  assert.throws(() => parseEvent(JSON.stringify({type:'error',message:'error',code:'generationFailed',nativeDomain:'/Users/secret'})));
  assert.throws(() => parseEvent(JSON.stringify({type:'error',message:'error',code:'unknown'})));
});
test('availability completion cannot count as a completed response', async t => {
  const file = fixture(t, `console.log('{"type":"ready"}');`);
  await assert.rejects(runHelper(file, {prompt:'hello',history:[]}, () => {}).done, e => e.code === 'protocolError');
});
