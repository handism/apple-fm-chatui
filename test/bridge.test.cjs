const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { parseEvent, checkStatus, generate, prepare, commitMessage } = require('../dist/bridge');

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
  await generate(file, { prompt: '世界', history: [{ role: 'user', text: 'こんにちは' }] }, e => events.push(e)).done;
  assert.deepEqual(events, [{ type: 'snapshot', text: 'こんにちは世界' }, { type: 'done' }]);
});
test('split JSON packets are joined', async t => {
  const file = fixture(t, `process.stdout.write('{"type":');setTimeout(()=>console.log('"ready"}'),20);`);
  await checkStatus(file).done;
});
test('reported unavailability is surfaced', async t => {
  const file = fixture(t, `console.log('{"type":"error","message":"モデルの準備中"}');`);
  await assert.rejects(checkStatus(file).done, /モデルの準備中/);
});
test('premature process exit does not count as success', async t => {
  const file = fixture(t, `console.log('{"type":"snapshot","text":"partial"}');`);
  await assert.rejects(generate(file, { prompt: 'test', history: [] }, () => {}).done, /終了/);
});
test('cancellation rejects and suppresses later events', async t => {
  const file = fixture(t, `setTimeout(()=>{console.log('{"type":"snapshot","text":"late"}');console.log('{"type":"done"}');},200);`);
  const events = [];
  const job = generate(file, { prompt: 'test', history: [] }, e => events.push(e));
  job.cancel(); await assert.rejects(job.done, /停止/); assert.deepEqual(events, []);
});
test('timeout kills a stalled helper', async t => {
  const file = fixture(t, `setTimeout(()=>{},10000);`);
  await assert.rejects(checkStatus(file, 30).done, /タイムアウト/);
});
test('missing executable reports launch failure', async () => {
  await assert.rejects(checkStatus('/missing-local-fm-helper').done, /起動|ENOENT/);
});

test('structured native error preserves safe category and numeric diagnostics', async t => {
  const file = fixture(t, `console.log('{"type":"error","message":"生成失敗","code":"generationFailed","nativeDomain":"ModelManagerServices.ModelManagerError","nativeCode":1008}');`);
  await assert.rejects(checkStatus(file).done, e => e.code === 'generationFailed' && e.nativeCode === 1008);
});
test('rejects diagnostic fields that could contain user data', () => {
  assert.throws(() => parseEvent(JSON.stringify({type:'error',message:'error',code:'generationFailed',nativeDomain:'/Users/secret'})));
  assert.throws(() => parseEvent(JSON.stringify({type:'error',message:'error',code:'unknown'})));
});
test('availability completion cannot count as a completed response', async t => {
  const file = fixture(t, `console.log('{"type":"ready"}');`);
  await assert.rejects(generate(file, {prompt:'hello',history:[]}, () => {}).done, e => e.code === 'protocolError');
});
test('response events cannot count as a successful availability check', async t => {
  for (const line of ['{"type":"done"}', '{"type":"snapshot","text":"x"}']) {
    const file = fixture(t, `console.log('${line}');`);
    await assert.rejects(checkStatus(file).done, e => e.code === 'protocolError');
  }
});
test('a spare helper waits for the request and is used once', async t => {
  const file = fixture(t, `let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{console.log(JSON.stringify({type:'snapshot',text:'pid'+process.pid+':'+JSON.parse(input).prompt}));console.log('{"type":"done"}');});`);
  const spare = prepare(file);
  await new Promise(resolve => setTimeout(resolve, 100));
  const events = [];
  await generate(file, { prompt: 'warm', history: [] }, e => events.push(e), undefined, spare).done;
  assert.match(events[0].text, /:warm$/);
  assert.equal(spare.take(), undefined);
  spare.dispose();
});
test('a spare that failed or exited falls back to a fresh helper', async t => {
  const file = fixture(t, `let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{console.log(JSON.stringify({type:'snapshot',text:JSON.parse(input).prompt}));console.log('{"type":"done"}');});`);
  const exited = fixture(t, `console.log('{"type":"error","message":"準備中","code":"modelNotReady"}');`);
  for (const spare of [prepare('/missing-local-fm-helper'), prepare(exited)]) {
    await new Promise(resolve => setTimeout(resolve, 150));
    const events = [];
    await generate(file, { prompt: 'fresh', history: [] }, e => events.push(e), undefined, spare).done;
    assert.deepEqual(events, [{ type: 'snapshot', text: 'fresh' }, { type: 'done' }]);
  }
});
test('disposing an idle spare stops it', async t => {
  const file = fixture(t, `setTimeout(()=>{},10000);`);
  const spare = prepare(file);
  spare.dispose();
  assert.equal(spare.take(), undefined);
});
test('commit events must carry string fields and a string body list', () => {
  assert.deepEqual(parseEvent('{"type":"commit","commitType":"feat","scope":"","subject":"add x","body":["a"]}').body, ['a']);
  assert.throws(() => parseEvent('{"type":"commit","commitType":"feat","scope":"","subject":"add x","body":"a"}'));
  assert.throws(() => parseEvent('{"type":"commit","commitType":"feat","scope":null,"subject":"add x","body":[]}'));
});
test('commit mode passes the diff and language to the helper and rejects chat snapshots', async t => {
  const file = fixture(t, `let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const r=JSON.parse(input);console.log(JSON.stringify({type:'commit',commitType:'feat',scope:process.argv[2],subject:r.diff,body:[r.language]}));console.log('{"type":"done"}');});`);
  const events = [];
  await commitMessage(file, { diff: '+x', language: 'ja' }, e => events.push(e)).done;
  assert.deepEqual(events[0], { type: 'commit', commitType: 'feat', scope: '--commit', subject: '+x', body: ['ja'] });
  const chat = fixture(t, `console.log('{"type":"snapshot","text":"x"}');console.log('{"type":"done"}');`);
  await assert.rejects(commitMessage(chat, { diff: '+x', language: 'en' }, () => {}).done, /予期しない/);
});
