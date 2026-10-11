const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { limits } = require('../dist/limits');

test('native helper enforces the same limits as the extension', () => {
  const swift = readFileSync(join(__dirname, '../native/LocalFM.swift'), 'utf8');
  const native = Object.fromEntries([...swift.matchAll(/static let (\w+) = (\d+)/g)].map(([, name, value]) => [name, Number(value)]));
  assert.deepEqual(native, { prompt: limits.prompt, historyTurns: limits.historyTurns, historyText: limits.historyText, commitDiff: limits.commitDiff });
});
