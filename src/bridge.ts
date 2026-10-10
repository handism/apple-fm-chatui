import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DiagnosticError, failureCodes, FailureCode } from './diagnostics';

export type Turn = { role: 'user' | 'assistant'; text: string };
export type Event = { type: 'ready' | 'done' } | { type: 'snapshot'; text: string } | { type: 'error'; message: string; code?: FailureCode; nativeDomain?: string; nativeCode?: number };
export function parseEvent(line: string): Event {
  const event = JSON.parse(line);
  if (event && (event.type === 'ready' || event.type === 'done' ||
    (event.type === 'snapshot' && typeof event.text === 'string') ||
    (event.type === 'error' && typeof event.message === 'string' &&
      (event.code === undefined || failureCodes.includes(event.code)) &&
      (event.nativeDomain === undefined || (typeof event.nativeDomain === 'string' && /^[A-Za-z0-9_.-]{1,160}$/.test(event.nativeDomain))) &&
      (event.nativeCode === undefined || Number.isSafeInteger(event.nativeCode))))) return event;
  throw new DiagnosticError('モデルから不正な応答を受信しました。', 'protocolError');
}

export function runHelper(binary: string, request: { prompt: string; history: Turn[] } | undefined,
  onEvent: (event: Event) => void, timeoutMs = 180_000) {
  const child = spawn(binary, request ? [] : ['--status'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let settled = false;
  let terminal = false;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    lines.close();
    if (error) { child.kill(); reject(error); } else resolve();
  };
  const timer = setTimeout(() => finish(new DiagnosticError('応答がタイムアウトしました。', 'timeout')), timeoutMs);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (settled || terminal) return;
    try {
      const event = parseEvent(line);
      if (event.type === 'error') { finish(new DiagnosticError(event.message, event.code || 'generationFailed', event.nativeDomain, event.nativeCode)); return; }
      if ((request && event.type === 'ready') || (!request && (event.type === 'done' || event.type === 'snapshot'))) {
        finish(new DiagnosticError('モデルから予期しない応答を受信しました。', 'protocolError')); return;
      }
      terminal = event.type === 'done' || event.type === 'ready';
      onEvent(event);
    } catch { finish(new DiagnosticError('モデルから不正な応答を受信しました。', 'protocolError')); }
  });
  // Drain stderr without recording prompts or OS diagnostic details.
  child.stderr.resume();
  child.on('error', () => finish(new DiagnosticError('モデル用プログラムを起動できません。', 'launchFailed')));
  child.stdin.on('error', () => { if (!terminal) finish(new DiagnosticError('モデル用プログラムとの通信が終了しました。', 'processExited')); });
  child.on('close', code => finish(terminal && code === 0 ? undefined : new DiagnosticError('モデル用プログラムが終了しました。', 'processExited')));
  child.stdin.end(request ? JSON.stringify(request) : undefined);
  return { done, cancel: () => finish(new DiagnosticError('生成を停止しました。', 'cancelled')) };
}
