const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compactDiff, formatCommit } = require('../dist/commit');

const file = (path, lines, header = '') => `diff --git a/${path} b/${path}\n${header}index 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@ function f()\n context\n${lines}\n`;

test('compact diff lists files, keeps changed lines only, and omits lock files and binaries', () => {
  const diff = file('src/a.ts', '-old\n+new') + file('package-lock.json', '+"x": 1') +
    'diff --git a/img.png b/img.png\nnew file mode 100644\nindex 0000000..3333333\nBinary files /dev/null and b/img.png differ\n' +
    'diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n';
  const out = compactDiff(diff, 6000);
  assert.match(out, /^Changed files:\n- src\/a\.ts \(modified, \+1 -1\)\n- package-lock\.json \(modified, \+1 -0, content omitted\)\n- img\.png \(added, binary\)\n- new\.ts \(renamed from old\.ts, \+0 -0\)\n/);
  assert.match(out, /\nsrc\/a\.ts\n@@ -1,3 \+1,3 @@ function f\(\)\n-old\n\+new/);
  assert.doesNotMatch(out, / context|index 111|\+\+\+ b|"x": 1/);
});

test('compact diff stays within budget and shares it so small files are kept whole', () => {
  const big = Array.from({ length: 2000 }, (_, i) => `+line ${i}`).join('\n');
  const diff = file('big.ts', big) + file('small.ts', '+tiny change');
  for (const budget of [6000, 3000, 1500]) {
    const out = compactDiff(diff, budget);
    assert.ok(out.length <= budget, `${out.length} > ${budget}`);
    assert.match(out, /\nsmall\.ts\n@@[^\n]*\n\+tiny change/);
    assert.match(out, /\nbig\.ts\n@@[^\n]*\n\+line 0\n[\s\S]*\n\[truncated\]/);
  }
  const many = Array.from({ length: 300 }, (_, i) => file(`dir/file-${i}.ts`, '+x')).join('');
  const out = compactDiff(many, 1500);
  assert.ok(out.length <= 1500);
  assert.match(out, /\.\.\. and \d+ more files\n/);
  assert.equal(compactDiff('', 6000), '');
});

test('format normalizes the structured answer into a Conventional Commits message', () => {
  assert.equal(formatCommit({ commitType: 'feat', scope: 'SCM', subject: 'Add commit message generation.', body: ['- Uses the Git API', '', '2) Halves the diff on overflow'] }),
    'feat(scm): add commit message generation\n\n- Uses the Git API\n- Halves the diff on overflow');
  assert.equal(formatCommit({ commitType: 'fix', scope: '', subject: 'fix(ui): API keys are not shown', body: [] }), 'fix: API keys are not shown');
  assert.equal(formatCommit({ commitType: 'docs', scope: 'two words', subject: 'Note: 説明を更新。', body: [] }), 'docs: note: 説明を更新');
  assert.equal(formatCommit({ commitType: 'unknown', scope: 'native', subject: 'ヘルパーを整理\nする', body: [] }), 'chore(native): ヘルパーを整理 する');
  assert.throws(() => formatCommit({ commitType: 'feat', scope: '', subject: ' . ', body: [] }));
});
