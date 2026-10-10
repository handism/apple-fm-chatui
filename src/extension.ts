import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { release } from 'node:os';
import { checkStatus, generate, prepare, Job, Spare, Turn } from './bridge';
import { DiagnosticError, diagnosticFailure, isFatal, recovery } from './diagnostics';
import { limits } from './limits';
import { SelectionEdits, SelectionEdit, SelectionAction, selectionActions } from './selection';

type Message = Turn & { incomplete?: boolean; editId?: string; note?: string };
class ChatProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private messages: Message[] = [];
  private history: Turn[] = [];
  private active?: Job;
  private spare?: Spare;
  private snapshotTimer?: NodeJS.Timeout;
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
    const values: Record<string, string> = { cspSource: view.webview.cspSource, nonce: randomBytes(18).toString('base64'),
      chatCss: asset('chat.css').toString(), chatJs: asset('chat.js').toString(), promptLimit: String(limits.prompt) };
    const template = readFileSync(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.html').fsPath, 'utf8');
    view.webview.html = template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key]);
    // Scoped to this view: VS Code resolves a new view each time the sidebar view is recreated.
    const subscriptions = [view.webview.onDidReceiveMessage((message: unknown) => {
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
    })];
    subscriptions.push(view.onDidDispose(() => { for (const item of subscriptions) item.dispose(); this.view = undefined; this.stop(); this.dropSpare(); }));
  }
  private publish() {
    // A full state supersedes any pending streamed text.
    clearTimeout(this.snapshotTimer); this.snapshotTimer = undefined;
    void this.view?.webview.postMessage({ type: 'state', messages: this.messages.map(message => ({ ...message, edit: message.editId ? this.edits.summary(message.editId) : undefined })), busy: this.busy, ready: this.ready, status: this.status, attachment: this.attachment,
      diagnostics: { availability: this.availability, lastResponseAt: this.lastResponseAt, lastCheckedAt: this.lastCheckedAt,
        code: this.failure?.code, guidance: this.failure ? recovery(this.failure.code) : undefined } });
  }
  // Streaming sends only the growing message, at most every 50ms, so the view does not rebuild the conversation per token.
  private publishSnapshot(index: number) {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      void this.view?.webview.postMessage({ type: 'snapshot', index, text: this.messages[index]?.text });
    }, 50);
  }
  private warmSpare() { if (this.ready && !this.spare && this.view) this.spare = prepare(this.binary()); }
  private dropSpare() { this.spare?.dispose(); this.spare = undefined; }
  private availableStatus() { return this.lastResponseAt ? '応答確認済み · Apple Foundation Models' : '利用可能 · 応答はまだ未確認'; }
  private fail(error: unknown, phase: 'availability' | 'generation') {
    this.failure = diagnosticFailure(error); this.failurePhase = phase;
    if (phase === 'availability') this.availability = 'unavailableOrFailed';
    this.status = this.failure.message;
    if (isFatal(this.failure.code)) { this.ready = false; this.dropSpare(); }
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
    // Not ready first, so stopping a generation does not start a spare that is dropped right away.
    this.ready = false; this.stop(); this.dropSpare();
    const id = ++this.generation;
    this.busy = true; this.failure = undefined; this.status = 'モデルを確認しています…'; this.publish();
    const job = checkStatus(this.binary());
    this.active = job;
    try { await job.done; if (id === this.generation) { this.ready = true; this.availability = 'available'; this.lastCheckedAt = new Date().toISOString(); this.status = this.availableStatus(); } }
    catch (error) { if (id === this.generation) { this.lastCheckedAt = new Date().toISOString(); this.fail(error, 'availability'); } }
    finally { if (id === this.generation) { this.active = undefined; this.busy = false; this.warmSpare(); this.publish(); } }
  }
  private async send(text: string, edit?: SelectionEdit) {
    if (this.busy || !this.ready || !text.trim()) return;
    const prompt = !edit && this.attachment ? `${text.trim()}\n\n添付テキスト:\n${this.attachment}` : text.trim();
    if (prompt.length > limits.prompt) { this.status = `入力と添付の合計を${count(limits.prompt)}文字以内にしてください。`; this.publish(); return; }
    const id = ++this.generation;
    this.busy = true; this.failure = undefined; if (!edit) this.attachment = ''; this.activeEdit = edit; this.status = 'このMacで生成中…';
    this.messages.push({ role: 'user', text: edit ? `${selectionActions[edit.action].label}\n\n${edit.selected}` : prompt });
    const answer: Message = { role: 'assistant', text: '', incomplete: true, ...(edit ? { editId: edit.id } : {}) };
    this.messages.push(answer); this.publish();
    const index = this.messages.length - 1;
    if (!edit) void this.view?.webview.postMessage({ type: 'accepted' });
    let history = edit ? [] : this.history;
    let dropped = 0;
    const trim = (turns: number) => { history = history.slice(turns); dropped += turns / 2; };
    // Each exchange adds two turns; keep the newest ones within the helper's limit.
    if (history.length + 2 > limits.historyTurns) trim(history.length + 2 - limits.historyTurns);
    try {
      for (;;) {
        const job = generate(this.binary(), { prompt, history }, event => {
          if (id === this.generation && event.type === 'snapshot') { answer.text = event.text; this.publishSnapshot(index); }
        }, undefined, this.spare);
        this.spare = undefined; this.active = job;
        try { await job.done; break; }
        catch (error) {
          // The on-device context window is small: retry with the older half of the exchanges dropped
          // before asking the user to start over.
          if (id !== this.generation || edit || !history.length || !(error instanceof DiagnosticError && error.code === 'contextLimit')) throw error;
          trim(Math.ceil(history.length / 4) * 2);
          answer.text = ''; this.status = '会話が長いため、古いやり取りを省いて生成し直しています…'; this.publish();
        }
      }
      if (id !== this.generation) return;
      if (!answer.text.trim()) throw new DiagnosticError('モデルから回答本文を受信できませんでした。', 'generationFailed');
      answer.incomplete = false;
      if (edit) this.edits.complete(edit, answer.text);
      else this.history = [...history, { role: 'user', text: prompt }, { role: 'assistant', text: answer.text }];
      if (dropped) answer.note = `古いやり取り${dropped}件は文脈から外して回答しました。`;
      this.lastResponseAt = new Date().toISOString();
      this.status = this.availableStatus();
    } catch (error) { if (id === this.generation) { if (edit) this.edits.fail(edit); this.fail(error, 'generation'); } }
    finally { if (id === this.generation) { this.active = undefined; this.activeEdit = undefined; this.busy = false; this.warmSpare(); this.publish(); } }
  }
  private stop() {
    ++this.generation;
    if (this.activeEdit) this.edits.fail(this.activeEdit);
    this.activeEdit = undefined;
    if (this.active) { this.active.cancel(); this.status = '停止しました。未完了のやり取りは次の会話に含みません。'; }
    this.active = undefined; this.busy = false; this.warmSpare(); this.publish();
  }
  async attachSelection() {
    const editor = vscode.window.activeTextEditor;
    const text = editor?.document.getText(editor.selection) || '';
    if (!text.trim()) { void vscode.window.showInformationMessage('エディタで添付するテキストを選択してください。'); return; }
    if (text.length > limits.selection) { void vscode.window.showWarningMessage(`添付は${count(limits.selection)}文字以内にしてください。`); return; }
    this.attachment = text;
    await vscode.commands.executeCommand('localFM.chat.focus'); this.publish();
  }
  async selectionAction(action: SelectionAction) {
    if (this.busy) { void vscode.window.showInformationMessage('現在の生成や状態確認が終わってから実行してください。'); return; }
    const edit = this.edits.capture(action);
    if (!edit) return;
    // The model check and focusing the view are awaited; the source may change or another request may start meanwhile.
    const startable = () => {
      if (this.ready && !this.busy && this.edits.current(edit)) return true;
      if (!this.edits.current(edit)) void vscode.window.showInformationMessage('元の文章が変わったため処理を開始できません。選択し直してください。');
      this.edits.abandon(edit); this.publish(); return false;
    };
    if (!this.ready) await this.check();
    if (!startable()) return;
    try {
      await vscode.commands.executeCommand('localFM.chat.focus');
      if (!startable()) return;
      await this.send(this.edits.prompt(edit), edit);
    } catch { this.edits.abandon(edit); this.publish(); void vscode.window.showWarningMessage('選択テキストの処理を開始できませんでした。'); }
  }
  dispose() { this.view = undefined; this.stop(); this.dropSpare(); this.edits.dispose(); }
}
const count = (value: number) => value.toLocaleString('en-US');
export function activate(context: vscode.ExtensionContext) {
  const provider = new ChatProvider(context);
  context.subscriptions.push(provider,
    vscode.window.registerWebviewViewProvider('localFM.chat', provider),
    vscode.commands.registerCommand('localFM.open', () => vscode.commands.executeCommand('localFM.chat.focus')),
    ...Object.keys(selectionActions).map(action => vscode.commands.registerCommand(`localFM.selection.${action}`, () => provider.selectionAction(action as SelectionAction))),
    vscode.commands.registerCommand('localFM.attachSelection', () => provider.attachSelection()));
}
