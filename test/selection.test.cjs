const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function setup() {
  let changed, closed, contentProvider, focusHook, editHook;
  const notices = [], previews = [];
  let editCalls = 0;
  const document = {
    text: '前文\r\n元の文章\r\n後文', version: 1, isClosed: false, eol: 2,
    uri: { scheme: 'file', toString: () => 'file:///source.txt' },
    getText: range => range ? document.text.slice(range.start, range.end) : document.text,
    offsetAt: position => position
  };
  class Range { constructor(start, end) { this.start = start; this.end = end; } }
  const editor = {
    document, selection: { start: 4, end: 8, isEmpty: false }, selections: [{}],
    edit: async (callback, options) => {
      editCalls++;
      const expectedVersion = document.version;
      let replacement;
      callback({ replace: (range, text) => { replacement = { range, text }; } });
      if (editHook) await editHook();
      if (document.version !== expectedVersion) return false;
      assert.deepEqual(options, { undoStopBefore: true, undoStopAfter: true });
      const { range, text } = replacement;
      document.text = document.text.slice(0, range.start) + text + document.text.slice(range.end);
      document.version++; changed({ document }); return true;
    }
  };
  const vscode = {
    Range, EndOfLine: { CRLF: 2, LF: 1 }, ViewColumn: { Beside: -2 },
    Uri: { parse: value => ({ toString: () => value }) },
    window: {
      activeTextEditor: editor,
      showInformationMessage: message => notices.push(message),
      showWarningMessage: message => notices.push(message),
      showTextDocument: async target => { assert.equal(target, document); if (focusHook) await focusHook(); return editor; }
    },
    commands: { executeCommand: async (...args) => { previews.push(args); } },
    workspace: {
      registerTextDocumentContentProvider: (scheme, provider) => { assert.equal(scheme, 'local-fm-preview'); contentProvider = provider; return { dispose() {} }; },
      onDidChangeTextDocument: fn => { changed = fn; return { dispose() {} }; },
      onDidCloseTextDocument: fn => { closed = fn; return { dispose() {} }; }
    }
  };
  const original = Module._load;
  Module._load = function (name, ...args) { return name === 'vscode' ? vscode : original.call(this, name, ...args); };
  let SelectionEdits;
  try { delete require.cache[require.resolve('../dist/selection')]; ({ SelectionEdits } = require('../dist/selection')); }
  finally { Module._load = original; }
  const manager = new SelectionEdits(() => {});
  return { manager, editor, document, notices, previews, vscode, content: uri => contentProvider.provideTextDocumentContent(uri),
    mutate: text => { document.text = text; document.version++; changed({ document }); },
    close: () => { document.isClosed = true; closed(document); },
    focusHook: fn => { focusHook = fn; }, editHook: fn => { editHook = fn; }, editCalls: () => editCalls };
}

test('each preset sends only selected text and requests replacement body', () => {
  const s = setup();
  for (const action of ['summarize', 'rewrite', 'translate', 'bullets']) {
    const edit = s.manager.capture(action);
    assert.equal(edit.selected, '元の文章');
    const prompt = s.manager.prompt(edit);
    assert.ok(prompt.includes('元の文章')); assert.ok(!prompt.includes('前文')); assert.ok(!prompt.includes('後文'));
    assert.match(prompt, /本文だけ/);
  }
  s.manager.dispose();
});
test('apply requires preview, compares whole document, replaces only captured range with source EOL', async () => {
  const s = setup(), edit = s.manager.capture('rewrite');
  s.manager.complete(edit, '新しい\n文章');
  await s.manager.apply(edit.id); assert.equal(s.editCalls(), 0);
  await s.manager.preview(edit.id);
  const [command, left, right] = s.previews[0]; assert.equal(command, 'vscode.diff');
  assert.equal(s.content(left), '前文\r\n元の文章\r\n後文');
  assert.equal(s.content(right), '前文\r\n新しい\r\n文章\r\n後文');
  // Active editor/selection can change; the captured source still receives the edit.
  s.editor.selection = { start: 0, end: 2 }; s.vscode.window.activeTextEditor = undefined;
  await s.manager.apply(edit.id);
  assert.equal(s.document.text, '前文\r\n新しい\r\n文章\r\n後文');
  assert.equal(s.manager.summary(edit.id).state, 'applied');
  await s.manager.apply(edit.id); assert.equal(s.editCalls(), 1);
  s.manager.dispose();
});
test('editing anywhere in source invalidates generated and previewed suggestions, even after undo', async () => {
  for (const previewed of [false, true]) {
    const s = setup(), edit = s.manager.capture('rewrite'); s.manager.complete(edit, 'replacement');
    if (previewed) await s.manager.preview(edit.id);
    const original = s.document.text; s.mutate(original + '!'); s.mutate(original);
    await s.manager.preview(edit.id); await s.manager.apply(edit.id);
    assert.equal(s.manager.summary(edit.id).state, 'stale'); assert.equal(s.editCalls(), 0);
    s.manager.dispose();
  }
});
test('source changes during generation cannot produce an applicable result', async () => {
  const s = setup(), edit = s.manager.capture('summarize'); s.mutate('changed');
  s.manager.complete(edit, 'late result'); await s.manager.preview(edit.id); await s.manager.apply(edit.id);
  assert.equal(s.editCalls(), 0); assert.equal(s.manager.summary(edit.id).state, 'stale');
  s.manager.dispose();
});
test('rechecks changes, close, and reset after awaiting editor focus', async () => {
  for (const race of ['change', 'close', 'reset']) {
    const s = setup(), edit = s.manager.capture('translate'); s.manager.complete(edit, 'English'); await s.manager.preview(edit.id);
    s.focusHook(() => { if (race === 'change') s.mutate('changed'); else if (race === 'close') s.close(); else s.manager.clear(); });
    await s.manager.apply(edit.id); assert.equal(s.editCalls(), 0);
    s.manager.dispose();
  }
});
test('version rejection at VS Code edit boundary leaves newer source intact', async () => {
  const s = setup(), edit = s.manager.capture('bullets'); s.manager.complete(edit, '- text'); await s.manager.preview(edit.id);
  s.editHook(() => s.mutate('newer source'));
  await s.manager.apply(edit.id);
  assert.equal(s.document.text, 'newer source'); assert.equal(s.manager.summary(edit.id).state, 'stale');
  s.manager.dispose();
});
test('discard, failure, close, and reset never allow subsequent apply', async () => {
  for (const action of ['discard', 'fail', 'close', 'clear']) {
    const s = setup(), edit = s.manager.capture('rewrite');
    if (action !== 'fail') { s.manager.complete(edit, 'replacement'); await s.manager.preview(edit.id); }
    if (action === 'close') s.close(); else s.manager[action](action === 'discard' ? edit.id : edit);
    await s.manager.apply(edit.id); assert.equal(s.editCalls(), 0); s.manager.dispose();
  }
});
test('multiple selections, preview documents, empty and oversized selections are rejected', () => {
  const s = setup(); s.editor.selections = [{}, {}]; assert.equal(s.manager.capture('rewrite'), undefined);
  s.editor.selections = [{}]; s.document.uri.scheme = 'local-fm-preview'; assert.equal(s.manager.capture('rewrite'), undefined);
  s.document.uri.scheme = 'file'; s.editor.selection.isEmpty = true; assert.equal(s.manager.capture('rewrite'), undefined);
  s.editor.selection.isEmpty = false; s.document.text = 'x'.repeat(8001); s.editor.selection = { start: 0, end: 8001, isEmpty: false };
  assert.equal(s.manager.capture('rewrite'), undefined); s.manager.dispose();
});
