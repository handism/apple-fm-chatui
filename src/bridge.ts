import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DiagnosticError, isFailureCode, FailureCode } from './diagnostics';

export type Turn = { role: 'user' | 'assistant'; text: string };
export type Request = { prompt: string; history: Turn[] };
export type Event = { type: 'ready' | 'done' } | { type: 'snapshot'; text: string } | { type: 'error'; message: string; code?: FailureCode; nativeDomain?: string; nativeCode?: number };
export type Job = { done: Promise<void>; cancel: () => void };
export function parseEvent(line: string): Event {
  const event = JSON.parse(line);
  if (event && (event.type === 'ready' || event.type === 'done' ||
    (event.type === 'snapshot' && typeof event.text === 'string') ||
    (event.type === 'error' && typeof event.message === 'string' &&
      (event.code === undefined || isFailureCode(event.code)) &&
      (event.nativeDomain === undefined || (typeof event.nativeDomain === 'string' && /^[A-Za-z0-9_.-]{1,160}$/.test(event.nativeDomain))) &&
      (event.nativeCode === undefined || Number.isSafeInteger(event.nativeCode))))) return event;
  throw new DiagnosticError('モデルから不正な応答を受信しました。', 'protocolError');
}

/** Asks the helper whether the model is available. Resolves only on `ready`. */
export function checkStatus(binary: string, timeoutMs = 15_000): Job {
  return run(binary, ['--status'], undefined, { allowed: ['ready'], terminal: 'ready' }, () => {}, timeoutMs);
}

/** Streams a response. Resolves only after `done`; snapshots carry the full text so far. */
export function generate(binary: string, request: Request, onEvent: (event: Event) => void, timeoutMs = 180_000): Job {
  return run(binary, [], JSON.stringify(request), { allowed: ['snapshot', 'done'], terminal: 'done' }, onEvent, timeoutMs);
}

type Protocol = { allowed: readonly Event['type'][]; terminal: Event['type'] };
function run(binary: string, args: string[], input: string | undefined, protocol: Protocol,
  onEvent: (event: Event) => void, timeoutMs: number): Job {
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
      if (!protocol.allowed.includes(event.type)) { finish(new DiagnosticError('モデルから予期しない応答を受信しました。', 'protocolError')); return; }
      terminal = event.type === protocol.terminal;
      onEvent(event);
    } catch { finish(new DiagnosticError('モデルから不正な応答を受信しました。', 'protocolError')); }
  });
  // Drain stderr without recording prompts or OS diagnostic details.
  child.stderr.resume();
  child.on('error', () => finish(new DiagnosticError('モデル用プログラムを起動できません。', 'launchFailed')));
  child.stdin.on('error', () => { if (!terminal) finish(new DiagnosticError('モデル用プログラムとの通信が終了しました。', 'processExited')); });
  child.on('close', code => finish(terminal && code === 0 ? undefined : new DiagnosticError('モデル用プログラムが終了しました。', 'processExited')));
  child.stdin.end(input);
  return { done, cancel: () => finish(new DiagnosticError('生成を停止しました。', 'cancelled')) };
}
