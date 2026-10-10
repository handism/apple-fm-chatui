export type FailureCode = 'unsupportedOS' | 'deviceNotEligible' | 'appleIntelligenceNotEnabled' | 'modelNotReady' | 'unavailable' | 'contextLimit' | 'refusal' | 'unsupportedLanguage' | 'rateLimited' | 'invalidInput' | 'generationFailed' | 'launchFailed' | 'timeout' | 'processExited' | 'protocolError' | 'cancelled';
export const failureCodes: FailureCode[] = ['unsupportedOS', 'deviceNotEligible', 'appleIntelligenceNotEnabled', 'modelNotReady', 'unavailable', 'contextLimit', 'refusal', 'unsupportedLanguage', 'rateLimited', 'invalidInput', 'generationFailed', 'launchFailed', 'timeout', 'processExited', 'protocolError', 'cancelled'];
export class DiagnosticError extends Error {
  constructor(message: string, public readonly code: FailureCode, public readonly nativeDomain?: string, public readonly nativeCode?: number) { super(message); }
}
export function recovery(code: FailureCode): string {
  switch (code) {
    case 'unsupportedOS': return 'macOS 26以降のApple Silicon搭載Macでご利用ください。';
    case 'deviceNotEligible': return 'Apple Intelligence対応のApple Silicon搭載Macが必要です。';
    case 'appleIntelligenceNotEnabled': return 'システム設定の「Apple IntelligenceとSiri」でApple Intelligenceを有効にしてから「再確認」を押してください。';
    case 'modelNotReady': return 'モデルのダウンロード完了を待ち、「再確認」を押してください。';
    case 'contextLimit': return '「新しい会話」で履歴をリセットし、入力や添付を短くして送信してください。';
    case 'refusal': return 'このリクエストには回答できませんでした。質問の内容や表現を見直してください。';
    case 'unsupportedLanguage': return 'Apple Intelligenceが対応する言語で入力してください。';
    case 'rateLimited': return '少し待ってから送信してください。';
    case 'invalidInput': return '入力や添付を短くして送信してください。';
    case 'launchFailed': return '拡張機能を再インストールし、VS Codeを再読み込みしてください。';
    case 'timeout': return '少し待って「再確認」を押し、短い入力で試してください。';
    case 'protocolError': case 'processExited': return 'VS Codeを再読み込みしてください。続く場合は診断情報をコピーして確認してください。';
    case 'cancelled': return '必要に応じて、次のメッセージを送信してください。';
    default: return '「再確認」後にもう一度送信してください。続く場合はApple Intelligenceの状態を確認し、診断情報をコピーしてください。';
  }
}
export function diagnosticFailure(error: unknown): DiagnosticError {
  // Never include raw exceptions, paths, prompts or model output in copied diagnostics.
  return error instanceof DiagnosticError ? error : new DiagnosticError('生成できませんでした。', 'generationFailed');
}
