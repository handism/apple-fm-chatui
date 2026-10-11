// Shared input limits. native/LocalFM.swift enforces the same values; test/limits.test.cjs keeps them in sync.
export const limits = {
  /** Characters per request prompt, including any attachment. */
  prompt: 12000,
  /** Characters per attachment or selection edit. */
  selection: 8000,
  /** Turns (user and assistant entries) sent as history. */
  historyTurns: 100,
  /** Characters per history turn. */
  historyText: 24000,
  /** Characters of compacted diff sent for a commit message; halved on a context-limit error. */
  commitDiff: 6000,
  /** Selection edit suggestions kept per conversation. */
  edits: 20
} as const;
