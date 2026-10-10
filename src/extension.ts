import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { release } from 'node:os';
import { runHelper, Turn } from './bridge';
import { DiagnosticError, diagnosticFailure, recovery } from './diagnostics';
import { SelectionEdits, SelectionEdit, SelectionAction, selectionActions } from './selection';

type Message = Turn & { incomplete?: boolean; editId?: string };
class ChatProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private messages: Message[] = [];
  private history: Turn[] = [];
  private active?: ReturnType<typeof runHelper>;
  private generation = 0;
  private busy = false;
  private ready = false;
  private lastResponseAt?: string;
  private lastCheckedAt?: string;
  private availability: 'unchecked' | 'available' | 'unavailableOrFailed' = 'unchecked';
  private failure?: DiagnosticError;
  private failurePhase?: 'availability' | 'generation';
  private status = 'モデルを確認しています…';
  private attachment = '';
  private edits: SelectionEdits;
  private activeEdit?: SelectionEdit;
  constructor(private readonly context: vscode.ExtensionContext) { this.edits = new SelectionEdits(() => this.publish()); }
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    const asset = (name: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
    const nonce = randomBytes(18).toString('base64');
    view.webview.html = `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${asset('chat.css')}"></head><body>
      <header class="topbar"><button id="status-toggle" class="quiet" aria-expanded="false" aria-controls="diagnostics" title="モデルの状態・診断"><span id="dot"></span><span id="status" role="status"></span><span class="chevron" aria-hidden="true">▾</span></button><button id="refresh" class="quiet icon" title="再確認" aria-label="再確認">↻</button><button id="reset" class="quiet icon" title="履歴を消して新しい会話" aria-label="新しい会話">＋</button></header>
      <section id="diagnostics" aria-label="モデルの状態・診断" hidden><p id="availability"></p><p id="response-check"></p><p id="recovery" role="status" hidden></p><p id="error-code" hidden></p><button id="copy-diagnostics" class="quiet">診断情報をコピー</button><span id="copy-status" role="status"></span><small>会話本文・添付・ファイルパスは含みません。</small></section>
      <main id="conversation" aria-label="会話"><section id="welcome"><div class="eyebrow">ON YOUR MAC</div><h1>ちょっと聞く。<br>さっと整える。</h1><p>Apple Foundation Modelsと話そう。<br>文章の整理も、アイデア出しも、ここから。</p><div class="suggestions"><button data-prompt="これから貼る文章を、要点3つにまとめてください。">文章を要約する</button><button data-prompt="これから貼る文章を、自然で読みやすい日本語に整えてください。">言葉を整える</button><button data-prompt="気分転換になる短い休憩のアイデアを3つください。">アイデアを広げる</button></div></section><div id="messages"></div></main>
      <footer><div id="attachment" hidden><span></span><button id="remove" class="quiet" aria-label="添付を解除">×</button></div><form id="composer"><label for="prompt" class="sr-only">メッセージ</label><textarea id="prompt" rows="2" maxlength="12000" placeholder="メッセージを入力（Shift+Enterで改行）"></textarea><div class="compose-actions"><button id="attach" type="button" class="quiet" title="エディタで選択したテキストを添付">＋ 選択テキスト</button><button id="stop" type="button" hidden>停止</button><button id="send" type="submit">送信 ↑</button></div></form><p class="footnote">端末内で処理 · 履歴は保存しません</p></footer><script nonce="${nonce}" src="${asset('chat.js')}"></script></body></html>`;
    this.context.subscriptions.push(view.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const data = message as Record<string, unknown>;
      switch (data.type) {
        case 'ready': this.publish(); if (!this.busy && !this.ready) void this.check(); break;
        case 'send': if (typeof data.text === 'string') void this.send(data.text); break;
        case 'stop': this.stop(); break;
        case 'reset':
          this.stop(); this.edits.clear(); this.messages = []; this.history = []; this.attachment = '';
          this.failure = undefined;
          if (this.ready) { this.status = this.availableStatus(); this.publish(); }
          else void this.check();
          break;
        case 'refresh': if (!this.busy) void this.check(); break;
        case 'copyDiagnostics': void this.copyDiagnostics(); break;
        case 'previewEdit': if (typeof data.id === 'string') void this.edits.preview(data.id); break;
        case 'applyEdit': if (typeof data.id === 'string') void this.edits.apply(data.id); break;
        case 'discardEdit': if (typeof data.id === 'string') this.edits.discard(data.id); break;
        case 'attach': void this.attachSelection(); break;
        case 'removeAttachment': this.attachment = ''; this.publish(); break;
        case 'copy': if (typeof data.index === 'number' && Number.isInteger(data.index) && this.messages[data.index]) void vscode.env.clipboard.writeText(this.messages[data.index].text); break;
      }
    }), view.onDidDispose(() => { this.view = undefined; this.stop(); }));
  }
  private publish() {
    void this.view?.webview.postMessage({ type: 'state', messages: this.messages.map(message => ({ ...message, edit: message.editId ? this.edits.summary(message.editId) : undefined })), busy: this.busy, ready: this.ready, status: this.status, attachment: this.attachment,
      diagnostics: { availability: this.availability, lastResponseAt: this.lastResponseAt, lastCheckedAt: this.lastCheckedAt,
        code: this.failure?.code, guidance: this.failure ? recovery(this.failure.code) : undefined } });
  }
  private availableStatus() { return this.lastResponseAt ? '応答確認済み · Apple Foundation Models' : '利用可能 · 応答はまだ未確認'; }
  private fail(error: unknown, phase: 'availability' | 'generation') {
    this.failure = diagnosticFailure(error); this.failurePhase = phase;
    if (phase === 'availability') this.availability = 'unavailableOrFailed';
    this.status = this.failure.message;
    if (['unsupportedOS', 'deviceNotEligible', 'appleIntelligenceNotEnabled', 'modelNotReady', 'unavailable', 'launchFailed', 'processExited', 'protocolError'].includes(this.failure.code)) this.ready = false;
  }
  private async copyDiagnostics() {
    const report = {
      extensionVersion: this.context.extension.packageJSON.version,
      vscodeVersion: vscode.version, platform: process.platform, architecture: process.arch, darwinRelease: release(),
      modelAvailability: this.availability,
      lastAvailabilityCheckAt: this.lastCheckedAt || null, lastSuccessfulResponseAt: this.lastResponseAt || null,
      lastFailure: this.failure ? { phase: this.failurePhase, category: this.failure.code, nativeDomain: this.failure.nativeDomain, nativeCode: this.failure.nativeCode } : null
    };
    try { await vscode.env.clipboard.writeText(JSON.stringify(report, null, 2)); void this.view?.webview.postMessage({ type: 'diagnosticsCopied' }); }
    catch { void vscode.window.showWarningMessage('診断情報をコピーできませんでした。'); }
  }
  private binary() { return vscode.Uri.joinPath(this.context.extensionUri, 'bin', 'local-fm').fsPath; }
  private async check() {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      this.fail(new DiagnosticError('Apple Silicon搭載のMacでご利用ください。', 'deviceNotEligible'), 'availability'); this.publish(); return;
    }
    if (Number(release().split('.')[0]) < 25) {
      this.fail(new DiagnosticError('macOS 26以降が必要です。', 'unsupportedOS'), 'availability'); this.publish(); return;
    }
    this.stop();
    const id = ++this.generation;
    this.busy = true; this.ready = false; this.failure = undefined; this.status = 'モデルを確認しています…'; this.publish();
    const job = runHelper(this.binary(), undefined, () => {}, 15000);
    this.active = job;
    try { await job.done; if (id === this.generation) { this.ready = true; this.availability = 'available'; this.lastCheckedAt = new Date().toISOString(); this.status = this.availableStatus(); } }
    catch (error) { if (id === this.generation) { this.lastCheckedAt = new Date().toISOString(); this.fail(error, 'availability'); } }
    finally { if (id === this.generation) { this.active = undefined; this.busy = false; this.publish(); } }
  }
  private async send(text: string, edit?: SelectionEdit) {
    if (this.busy || !this.ready || !text.trim()) return;
    const prompt = !edit && this.attachment ? `${text.trim()}\n\n添付テキスト:\n${this.attachment}` : text.trim();
    if (prompt.length > 12000) { this.status = '入力と添付の合計を12,000文字以内にしてください。'; this.publish(); return; }
    if (!edit && this.history.length >= 100) { this.status = '会話が長くなりました。「新しい会話」で続けてください。'; this.publish(); return; }
    const id = ++this.generation;
    this.busy = true; this.failure = undefined; if (!edit) this.attachment = ''; this.activeEdit = edit; this.status = 'このMacで生成中…';
    this.messages.push({ role: 'user', text: edit ? `${selectionActions[edit.action].label}\n\n${edit.selected}` : prompt });
    const answer: Message = { role: 'assistant', text: '', incomplete: true, ...(edit ? { editId: edit.id } : {}) };
    this.messages.push(answer); this.publish();
    if (!edit) void this.view?.webview.postMessage({ type: 'accepted' });
    const job = runHelper(this.binary(), { prompt, history: edit ? [] : this.history }, event => {
      if (id !== this.generation) return;
      if (event.type === 'snapshot') { answer.text = event.text; this.publish(); }
    });
    this.active = job;
    try {
      await job.done;
      if (id !== this.generation) return;
      if (!answer.text.trim()) throw new DiagnosticError('モデルから回答本文を受信できませんでした。', 'generationFailed');
      answer.incomplete = false;
      if (edit) this.edits.complete(edit, answer.text);
      else this.history.push({ role: 'user', text: prompt }, { role: 'assistant', text: answer.text });
      this.lastResponseAt = new Date().toISOString();
      this.status = this.availableStatus();
    } catch (error) { if (id === this.generation) { if (edit) this.edits.fail(edit); this.fail(error, 'generation'); } }
    finally { if (id === this.generation) { this.active = undefined; this.activeEdit = undefined; this.busy = false; this.publish(); } }
  }
  private stop() {
    ++this.generation;
    if (this.activeEdit) this.edits.fail(this.activeEdit);
    this.activeEdit = undefined;
    if (this.active) { this.active.cancel(); this.status = '停止しました。未完了のやり取りは次の会話に含みません。'; }
    this.active = undefined; this.busy = false; this.publish();
  }
  async attachSelection() {
    const editor = vscode.window.activeTextEditor;
    const text = editor?.document.getText(editor.selection) || '';
    if (!text.trim()) { void vscode.window.showInformationMessage('エディタで添付するテキストを選択してください。'); return; }
    if (text.length > 8000) { void vscode.window.showWarningMessage('添付は8,000文字以内にしてください。'); return; }
    this.attachment = text;
    await vscode.commands.executeCommand('localFM.chat.focus'); this.publish();
  }
  async selectionAction(action: SelectionAction) {
    if (this.busy) { void vscode.window.showInformationMessage('現在の生成や状態確認が終わってから実行してください。'); return; }
    const edit = this.edits.capture(action);
    if (!edit) return;
    if (!this.ready) await this.check();
    if (!this.ready || this.busy || !this.edits.current(edit)) {
      if (!this.edits.current(edit)) void vscode.window.showInformationMessage('元の文章が変わったため処理を開始できません。選択し直してください。');
      this.edits.abandon(edit); this.publish(); return;
    }
    try {
      await vscode.commands.executeCommand('localFM.chat.focus');
      if (this.busy || !this.ready || !this.edits.current(edit)) {
        if (!this.edits.current(edit)) void vscode.window.showInformationMessage('元の文章が変わったため処理を開始できません。選択し直してください。');
        this.edits.abandon(edit); this.publish(); return;
      }
      await this.send(this.edits.prompt(edit), edit);
    } catch { this.edits.abandon(edit); this.publish(); void vscode.window.showWarningMessage('選択テキストの処理を開始できませんでした。'); }
  }
  dispose() { this.stop(); this.edits.dispose(); }
}
export function activate(context: vscode.ExtensionContext) {
  const provider = new ChatProvider(context);
  context.subscriptions.push(provider,
    vscode.window.registerWebviewViewProvider('localFM.chat', provider),
    vscode.commands.registerCommand('localFM.open', () => vscode.commands.executeCommand('localFM.chat.focus')),
    ...Object.keys(selectionActions).map(action => vscode.commands.registerCommand(`localFM.selection.${action}`, () => provider.selectionAction(action as SelectionAction))),
    vscode.commands.registerCommand('localFM.attachSelection', () => provider.attachSelection()));
}
