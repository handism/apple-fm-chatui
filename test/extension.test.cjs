const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

test('view sends completed history, rejects double send, and ignores stale completion after reset', async () => {
  let provider, listener;
  const states = [], jobs = [];
  const commands = new Map();
  let copied;
  const { DiagnosticError } = require("../dist/diagnostics");
  const vscode = {
    workspace: { registerTextDocumentContentProvider: () => ({ dispose() {} }), onDidChangeTextDocument: () => ({ dispose() {} }), onDidCloseTextDocument: () => ({ dispose() {} }) },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } }, EndOfLine: { CRLF: 2, LF: 1 },
    version: "1.105.0", env: { clipboard: { writeText: async text => { copied = text; } } },
    Uri: { joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts), toString: () => parts.join('/') }) },
    window: { registerWebviewViewProvider: (_, p) => { provider = p; return { dispose() {} }; } },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return { dispose() {} }; }, executeCommand: async name => { if (name === 'localFM.chat.focus') listener({ type: 'ready' }); } }
  };
  const original = Module._load;
  Module._load = function (id, ...args) {
    if (id === 'vscode') return vscode;
    if (id === './bridge') {
      const job = (request, onEvent) => {
        let resolve, reject;
        const done = new Promise((yes, no) => { resolve = yes; reject = no; });
        const job = { request, onEvent, resolve, reject, done, cancel() { /* Simulate a late completion. */ } };
        jobs.push(job); return job;
      };
      return { checkStatus: () => job(undefined, () => {}), generate: (binary, request, onEvent) => job(request, onEvent) };
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
  assert.doesNotMatch(webview.html, /\{\{/);
  assert.match(webview.html, /maxlength="12000"/);
  assert.match(webview.html, /script-src 'nonce-([^']+)'[\s\S]*<script nonce="\1" src="media\/chat\.js">/);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  listener({ type: 'ready' }); jobs[0].resolve(); await tick();
  assert.match(states.at(-1).status, /応答はまだ未確認/);
  assert.equal(states.at(-1).diagnostics.lastResponseAt, undefined);
  listener({ type: 'send', text: 'hello' });
  listener({ type: 'send', text: 'duplicate' });
  assert.equal(jobs.length, 2);
  jobs[1].onEvent({ type: 'snapshot', text: 'world' });
  assert.equal(states.at(-1).diagnostics.lastResponseAt, undefined);
  jobs[1].resolve(); await tick();
  assert.match(states.at(-1).status, /応答確認済み/);
  const lastSuccess = states.at(-1).diagnostics.lastResponseAt;
  listener({ type: 'send', text: 'follow-up' });
  assert.deepEqual(jobs[2].request.history, [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'world' }]);
  listener({ type: 'reset' });
  jobs[2].onEvent({ type: 'snapshot', text: 'stale' }); jobs[2].resolve(); await tick();
  assert.deepEqual(states.at(-1).messages, []);
  listener({ type: 'send', text: 'fresh' });
  assert.deepEqual(jobs[3].request.history, []);
  jobs[3].reject(new Error('failure')); await tick();
  assert.equal(states.at(-1).busy, false);
  assert.equal(states.at(-1).diagnostics.code, 'generationFailed');
  assert.equal(states.at(-1).diagnostics.lastResponseAt, lastSuccess);
  listener({ type: 'send', text: 'retry' });
  assert.deepEqual(jobs[4].request.history, []);
  jobs[4].reject(new DiagnosticError('会話の上限', 'contextLimit', 'ModelManagerServices.ModelManagerError', 1008)); await tick();
  assert.match(states.at(-1).diagnostics.guidance, /新しい会話/);
  listener({ type: 'copyDiagnostics' }); await tick();
  const report = JSON.parse(copied);
  assert.equal(report.lastFailure.category, 'contextLimit');
  assert.equal(report.lastFailure.nativeCode, 1008);
  assert.equal(report.lastSuccessfulResponseAt, lastSuccess);
  for (const secret of ['hello', 'world', 'follow-up', 'fresh', process.cwd()]) assert.ok(!copied.includes(secret));
  listener({ type: 'reset' });
  assert.equal(states.at(-1).diagnostics.code, undefined);
  assert.equal(states.at(-1).diagnostics.lastResponseAt, lastSuccess);
  listener({ type: 'send', text: 'empty response' }); jobs[5].resolve(); await tick();
  assert.equal(states.at(-1).diagnostics.code, 'generationFailed');
  listener({ type: 'send', text: 'not ready' });
  jobs[6].reject(new DiagnosticError('モデル準備中', 'modelNotReady')); await tick();
  assert.equal(states.at(-1).ready, false);
  assert.match(states.at(-1).diagnostics.guidance, /ダウンロード/);
  listener({ type: 'refresh' }); jobs[7].resolve(); await tick();
  assert.equal(states.at(-1).ready, true);
  assert.equal(states.at(-1).diagnostics.code, undefined);
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
  const editAnswer = states.at(-1).messages.at(-1);
  assert.equal(editAnswer.edit.state, 'generated');
  assert.equal(states.at(-1).attachment, 'selected text');
  assert.equal(states.filter(s => s.type === 'accepted').length, acceptedBefore);
  listener({ type: 'send', text: 'chat after edit' });
  assert.deepEqual(jobs[10].request.history, [{ role: 'user', text: 'chat before edit' }, { role: 'assistant', text: 'chat answer' }]);
  jobs[10].onEvent({ type: 'snapshot', text: 'after' }); jobs[10].resolve(); await tick();
  const cancelledAction = commands.get('localFM.selection.rewrite')(); await tick();
  listener({ type: 'stop' });
  jobs[11].onEvent({ type: 'snapshot', text: 'stale edit' }); jobs[11].resolve(); await cancelledAction;
  assert.equal(states.at(-1).messages.at(-1).edit.state, 'failed');
  assert.equal(states.at(-1).messages.at(-1).text, '');
  provider.dispose();
});
