const assert = require('node:assert/strict');
const vscode = require('vscode');
exports.run = async () => {
  const extension = vscode.extensions.getExtension('local-fm.apple-fm-chatui');
  assert.ok(extension, 'extension registered');
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('localFM.open'));
  for (const action of ['summarize', 'rewrite', 'translate', 'bullets']) assert.ok(commands.includes(`localFM.selection.${action}`));
  await vscode.commands.executeCommand('localFM.open');
  const document = await vscode.workspace.openTextDocument({ content: '添付テキストのテスト', language: 'plaintext' });
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(0, 0, 0, 5);
  await vscode.commands.executeCommand('localFM.attachSelection');
  // Exercise the real VS Code diff/editor APIs with a deterministic replacement.
  // This verifies editing behavior, not generation quality or real-model output.
  const { SelectionEdits } = require('../dist/selection');
  const source = await vscode.workspace.openTextDocument({ content: '前文\n元の文章\n後文', language: 'plaintext' });
  const sourceEditor = await vscode.window.showTextDocument(source, { preview: false });
  sourceEditor.selection = new vscode.Selection(1, 0, 1, 4);
  const edits = new SelectionEdits(() => {});
  try {
    const edit = edits.capture('rewrite'); assert.ok(edit);
    edits.complete(edit, '読みやすい文章'); await edits.preview(edit.id);
    assert.equal(edits.summary(edit.id).state, 'previewed');
    await edits.apply(edit.id);
    assert.equal(source.getText(), '前文\n読みやすい文章\n後文');
    assert.equal(edits.summary(edit.id).state, 'applied');
    await vscode.commands.executeCommand('undo');
    assert.equal(source.getText(), '前文\n元の文章\n後文');
    sourceEditor.selection = new vscode.Selection(1, 0, 1, 4);
    const stale = edits.capture('rewrite'); assert.ok(stale);
    edits.complete(stale, '上書きしてはいけない文章'); await edits.preview(stale.id);
    await sourceEditor.edit(builder => builder.insert(new vscode.Position(0, 0), '追記'));
    const newer = source.getText(); await edits.apply(stale.id);
    assert.equal(source.getText(), newer); assert.equal(edits.summary(stale.id).state, 'stale');
  } finally { edits.dispose(); }
  console.log('Local FM: activation, selection attachment, diff, range replacement, Undo, and stale-edit protection passed.');
};
