const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const { DiagnosticError } = require('../dist/diagnostics');
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup() {
  let provider, listener;
  const states = [], jobs = [], spares = [];
  const commands = new Map();
  const clipboard = {};
  const vscode = {
    workspace: { registerTextDocumentContentProvider: () => ({ dispose() {} }), onDidChangeTextDocument: () => ({ dispose() {} }), onDidCloseTextDocument: () => ({ dispose() {} }) },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } }, EndOfLine: { CRLF: 2, LF: 1 },
    version: "1.105.0", env: { clipboard: { writeText: async text => { clipboard.text = text; } } },
    Uri: { parse: value => { const u = new URL(value); return { scheme: u.protocol.slice(0, -1), authority: u.host, path: decodeURIComponent(u.pathname), query: u.search, fragment: u.hash }; }, joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts), toString: () => parts.join('/') }) },
    window: { registerWebviewViewProvider: (_, p) => { provider = p; return { dispose() {} }; } },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return { dispose() {} }; }, executeCommand: async name => { if (name === 'localFM.chat.focus') listener({ type: 'ready' }); } }
  };
  const original = Module._load;
  Module._load = function (id, ...args) {
    if (id === 'vscode') return vscode;
    if (id === './bridge') {
      const job = (request, onEvent, spare) => {
        let resolve, reject;
        const done = new Promise((yes, no) => { resolve = yes; reject = no; });
        const job = { request, onEvent, resolve, reject, done, spare, cancel() { /* Simulate a late completion. */ } };
        jobs.push(job); return job;
      };
      return {
        checkStatus: (binary, timeout, onEvent) => job(undefined, onEvent || (() => {})),
        generate: (binary, request, onEvent, timeoutMs, spare) => { if (spare) spare.taken = true; return job(request, onEvent, spare); },
        prepare: () => { const spare = { taken: false, disposed: false, dispose() { if (!this.taken) this.disposed = true; } }; spares.push(spare); return spare; }
      };
    }
    return original.call(this, id, ...args);
  };
  try {
    delete require.cache[require.resolve('../dist/extension')];
    require('../dist/extension').activate({ extensionUri: { fsPath: process.cwd() }, extension: { packageJSON: { version: "0.1.1" } }, subscriptions: [] });
  } finally { Module._load = original; }
  const webview = {
    cspSource: 'vscode-webview:', asWebviewUri: x => x,
    postMessage: data => { states.push(structuredClone(data)); return Promise.resolve(true); },
    onDidReceiveMessage: fn => { listener = fn; return { dispose() {} }; }
  };
  provider.resolveWebviewView({ webview, onDidDispose: () => ({ dispose() {} }) });
  const last = () => states.filter(s => s.type === 'state').at(-1);
  return { provider, webview, states, jobs, spares, commands, vscode, clipboard, last, send: message => listener(message) };
}

test('view sends completed history, rejects double send, and ignores stale completion after reset', async () => {
  const { provider, webview, states, jobs, commands, vscode, clipboard, last, send: listener } = setup();
  assert.doesNotMatch(webview.html, /\{\{/);
  assert.match(webview.html, /maxlength="12000"/);
  assert.match(webview.html, /script-src 'nonce-([^']+)'[\s\S]*<script nonce="\1" src="media\/chat\.js">/);
  listener({ type: 'ready' }); jobs[0].resolve(); await tick();
  assert.match(last().status, /応答はまだ未確認/);
  assert.equal(last().diagnostics.lastResponseAt, undefined);
  listener({ type: 'send', text: 'hello' });
  listener({ type: 'send', text: 'duplicate' });
  assert.equal(jobs.length, 2);
  jobs[1].onEvent({ type: 'snapshot', text: 'world' });
  assert.equal(last().diagnostics.lastResponseAt, undefined);
  jobs[1].resolve(); await tick();
  assert.match(last().status, /応答確認済み/);
  const lastSuccess = last().diagnostics.lastResponseAt;
  listener({ type: 'send', text: 'follow-up' });
  assert.deepEqual(jobs[2].request.history, [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'world' }]);
  listener({ type: 'reset' });
  jobs[2].onEvent({ type: 'snapshot', text: 'stale' }); jobs[2].resolve(); await tick();
  assert.deepEqual(last().messages, []);
  listener({ type: 'send', text: 'fresh' });
  assert.deepEqual(jobs[3].request.history, []);
  jobs[3].reject(new Error('failure')); await tick();
  assert.equal(last().busy, false);
  assert.equal(last().diagnostics.code, 'generationFailed');
  assert.equal(last().diagnostics.lastResponseAt, lastSuccess);
  listener({ type: 'send', text: 'retry' });
  assert.deepEqual(jobs[4].request.history, []);
  jobs[4].reject(new DiagnosticError('会話の上限', 'contextLimit', 'ModelManagerServices.ModelManagerError', 1008)); await tick();
  assert.match(last().diagnostics.guidance, /新しい会話/);
  listener({ type: 'copyDiagnostics' }); await tick();
  const report = JSON.parse(clipboard.text);
  assert.equal(report.lastFailure.category, 'contextLimit');
  assert.equal(report.lastFailure.nativeCode, 1008);
  assert.equal(report.lastSuccessfulResponseAt, lastSuccess);
  for (const secret of ['hello', 'world', 'follow-up', 'fresh', process.cwd()]) assert.ok(!clipboard.text.includes(secret));
  listener({ type: 'reset' });
  assert.equal(last().diagnostics.code, undefined);
  assert.equal(last().diagnostics.lastResponseAt, lastSuccess);
  listener({ type: 'send', text: 'empty response' }); jobs[5].resolve(); await tick();
  assert.equal(last().diagnostics.code, 'generationFailed');
  listener({ type: 'send', text: 'not ready' });
  jobs[6].reject(new DiagnosticError('モデル準備中', 'modelNotReady')); await tick();
  assert.equal(last().ready, false);
  assert.match(last().diagnostics.guidance, /ダウンロード/);
  listener({ type: 'refresh' }); jobs[7].resolve(); await tick();
  assert.equal(last().ready, true);
  assert.equal(last().diagnostics.code, undefined);
  listener({ type: 'send', text: 'chat before edit' });
  jobs[8].onEvent({ type: 'snapshot', text: 'chat answer' }); jobs[8].resolve(); await tick();
  const source = { uri: { scheme: 'file' }, version: 1, isClosed: false, eol: 1,
    getText: range => range ? 'selected text' : 'before selected text after', offsetAt: value => value };
  vscode.window.activeTextEditor = { document: source, selections: [{}], selection: { start: 7, end: 20, isEmpty: false } };
  listener({ type: 'attach' }); await tick();
  const acceptedBefore = states.filter(s => s.type === 'accepted').length;
  const action = commands.get('localFM.selection.summarize')(); await tick();
  assert.deepEqual(jobs[9].request.history, []);
  assert.match(jobs[9].request.prompt, /selected text/);
  assert.ok(!jobs[9].request.prompt.includes('before selected text after'));
  jobs[9].onEvent({ type: 'snapshot', text: 'summary' }); jobs[9].resolve(); await action;
  const editAnswer = last().messages.at(-1);
  assert.equal(editAnswer.edit.state, 'generated');
  assert.equal(last().attachment, 'selected text');
  assert.equal(states.filter(s => s.type === 'accepted').length, acceptedBefore);
  listener({ type: 'send', text: 'chat after edit' });
  assert.deepEqual(jobs[10].request.history, [{ role: 'user', text: 'chat before edit' }, { role: 'assistant', text: 'chat answer' }]);
  jobs[10].onEvent({ type: 'snapshot', text: 'after' }); jobs[10].resolve(); await tick();
  const cancelledAction = commands.get('localFM.selection.rewrite')(); await tick();
  listener({ type: 'stop' });
  jobs[11].onEvent({ type: 'snapshot', text: 'stale edit' }); jobs[11].resolve(); await cancelledAction;
  assert.equal(last().messages.at(-1).edit.state, 'failed');
  assert.equal(last().messages.at(-1).text, '');
  provider.dispose();
});

async function exchange(s, text) {
  s.send({ type: 'send', text });
  const job = s.jobs.at(-1);
  job.onEvent({ type: 'snapshot', text: `${text}!` }); job.resolve(); await tick();
  return job;
}

test('streaming posts only the latest text of the growing message, batched', async () => {
  const s = setup();
  s.send({ type: 'ready' }); s.jobs[0].resolve(); await tick();
  s.send({ type: 'send', text: 'hello' });
  const before = s.states.length;
  for (const text of ['a', 'ab', 'abc']) s.jobs[1].onEvent({ type: 'snapshot', text });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(s.states.slice(before), [{ type: 'snapshot', index: 1, text: 'abc' }]);
  // A pending snapshot is superseded by the full state on completion.
  s.jobs[1].onEvent({ type: 'snapshot', text: 'abcd' }); s.jobs[1].resolve(); await tick();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(s.states.at(-1).type, 'state');
  assert.equal(s.last().messages[1].text, 'abcd');
  s.provider.dispose();
});

test('a spare helper is prepared after each request and dropped when it cannot be used', async () => {
  const s = setup();
  s.send({ type: 'ready' }); assert.equal(s.spares.length, 0);
  s.jobs[0].resolve(); await tick();
  assert.equal(s.spares.length, 1);
  await exchange(s, 'hello');
  assert.equal(s.jobs[1].spare, s.spares[0]);
  assert.equal(s.spares.length, 2);
  s.send({ type: 'refresh' });
  assert.equal(s.spares[1].disposed, true);
  s.jobs.at(-1).resolve(); await tick();
  assert.equal(s.spares.length, 3);
  s.send({ type: 'send', text: 'unavailable' });
  s.jobs.at(-1).reject(new DiagnosticError('モデル準備中', 'modelNotReady')); await tick();
  assert.equal(s.spares.length, 3);
  s.provider.dispose();
  assert.equal(s.spares.every(spare => spare.taken || spare.disposed), true);
});

test('context limit drops the older half of the exchanges and retries', async () => {
  const s = setup();
  s.send({ type: 'ready' }); s.jobs[0].resolve(); await tick();
  for (const text of ['one', 'two', 'three']) await exchange(s, text);
  s.send({ type: 'send', text: 'four' });
  assert.equal(s.jobs.at(-1).request.history.length, 6);
  s.jobs.at(-1).onEvent({ type: 'snapshot', text: 'partial' });
  s.jobs.at(-1).reject(new DiagnosticError('上限', 'contextLimit')); await tick();
  assert.deepEqual(s.jobs.at(-1).request.history.map(turn => turn.text), ['three', 'three!']);
  assert.equal(s.last().messages.at(-1).text, '');
  s.jobs.at(-1).onEvent({ type: 'snapshot', text: 'four!' }); s.jobs.at(-1).resolve(); await tick();
  assert.match(s.last().messages.at(-1).note, /2件/);
  assert.equal(s.last().diagnostics.code, undefined);
  s.send({ type: 'send', text: 'five' });
  assert.deepEqual(s.jobs.at(-1).request.history.map(turn => turn.text), ['three', 'three!', 'four', 'four!']);
  // With no history left to drop, the failure reaches the user.
  s.jobs.at(-1).reject(new DiagnosticError('上限', 'contextLimit')); await tick();
  s.jobs.at(-1).reject(new DiagnosticError('上限', 'contextLimit')); await tick();
  assert.deepEqual(s.jobs.at(-1).request.history, []);
  s.jobs.at(-1).reject(new DiagnosticError('上限', 'contextLimit')); await tick();
  assert.equal(s.last().diagnostics.code, 'contextLimit');
  assert.equal(s.last().busy, false);
  s.provider.dispose();
});

test('long conversations keep the newest exchanges within the turn limit', async () => {
  const s = setup();
  s.send({ type: 'ready' }); s.jobs[0].resolve(); await tick();
  for (let i = 0; i < 50; i++) await exchange(s, `m${i}`);
  s.send({ type: 'send', text: 'next' });
  const history = s.jobs.at(-1).request.history;
  assert.equal(history.length, 98);
  assert.equal(history[0].text, 'm1');
  s.provider.dispose();
});


test('image attachment is sent, retained for follow-up, and cleared by reset', async () => {
  const s = setup();
  s.send({ type: 'ready' }); s.jobs[0].onEvent({ type: 'ready', images: true }); s.jobs[0].resolve(); await tick();
  s.vscode.window.showOpenDialog = async () => [{ path: '/private/example.png' }];
  s.vscode.workspace.fs = { stat: async () => ({ size: 8 }), readFile: async () => Buffer.from([137,80,78,71,13,10,26,10]) };
  s.send({ type: 'attachImage' }); await tick(); await tick();
  assert.equal(s.last().image.name, 'example.png');
  s.send({ type: 'send', text: '' });
  const job = s.jobs.at(-1);
  assert.equal(job.request.image.mime, 'image/png');
  assert.match(job.request.prompt, /画像/);
  assert.equal(s.last().image, undefined);
  job.onEvent({ type: 'snapshot', text: '赤い画像' }); job.resolve(); await tick();
  s.send({ type: 'send', text: '色は？' });
  assert.equal(s.jobs.at(-1).request.history[0].image.data, job.request.image.data);
  s.send({ type: 'reset' });
  assert.deepEqual(s.last().messages, []);
  s.provider.dispose();
});

test('image picker result after reset is ignored; unsupported helper cannot select images', async () => {
  const s = setup();
  s.send({ type: 'ready' }); s.jobs[0].resolve(); await tick();
  let selected = 0, resolvePicker;
  s.vscode.window.showOpenDialog = () => { selected++; return new Promise(resolve => { resolvePicker = resolve; }); };
  s.send({ type: 'attachImage' }); assert.equal(selected, 0);
  s.send({ type: 'refresh' }); s.jobs.at(-1).onEvent({ type: 'ready', images: true }); s.jobs.at(-1).resolve(); await tick();
  s.send({ type: 'attachImage' }); assert.equal(selected, 1);
  s.send({ type: 'reset' }); resolvePicker([{ path: '/private/late.png' }]); await tick();
  assert.equal(s.last().image, undefined);
  s.provider.dispose();
});


test('Finder bytes and Explorer URI drops attach without sending; invalid and stale drops preserve attachment', async () => {
  const s = setup();
  s.send({ type: 'ready' }); s.jobs[0].onEvent({ type: 'ready', images: true }); s.jobs[0].resolve(); await tick();
  const bytes = Buffer.from([137,80,78,71,13,10,26,10]);
  const drop = image => s.send({ type: 'dropImage', token: s.last().imageToken, image });
  drop({ name: 'finder.png', data: bytes.toString('base64') });
  assert.equal(s.last().image.name, 'finder.png'); assert.equal(s.jobs.length, 1);
  let reads = 0;
  s.vscode.workspace.fs = { stat: async () => ({ size: bytes.length }), readFile: async () => { reads++; return bytes; } };
  s.send({ type: 'dropImage', token: s.last().imageToken, uri: 'file:///tmp/Explorer%20image.png' }); await tick();
  assert.equal(s.last().image.name, 'Explorer image.png'); assert.equal(reads, 1);
  for (const uri of ['https://example.com/a.png', 'file://server/a.png', 'file:///tmp/secret.txt', 'command:workbench.action.closeWindow', 'file:///tmp/a.png?x=1']) {
    s.send({ type: 'dropImage', token: s.last().imageToken, uri }); await tick();
    assert.equal(reads, 1); assert.equal(s.last().image.name, 'Explorer image.png');
  }
  drop({ name: 'fake.png', data: Buffer.from('<svg/>').toString('base64') });
  assert.equal(s.last().image.name, 'Explorer image.png');
  const staleToken = s.last().imageToken;
  s.send({ type: 'reset' });
  s.send({ type: 'dropImage', token: staleToken, image: { name: 'old.png', data: bytes.toString('base64') } });
  assert.equal(s.last().image, undefined);
  let finish;
  s.vscode.workspace.fs.readFile = () => new Promise(resolve => { finish = resolve; });
  s.send({ type: 'dropImage', token: s.last().imageToken, uri: 'file:///tmp/slow.png' }); await tick();
  drop({ name: 'new.png', data: bytes.toString('base64') });
  finish(bytes); await tick();
  assert.equal(s.last().image.name, 'new.png');
  s.provider.dispose();
});
