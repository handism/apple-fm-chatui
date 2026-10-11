// Turns a git diff into model input that fits the on-device context, and the model's structured answer into a message.
export const commitTypes = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore'] as const;
export type CommitFields = { commitType: string; scope: string; subject: string; body: string[] };

// Generated or vendored content says little about intent and would crowd out the real changes.
const opaque = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|composer\.lock|go\.sum|Package\.resolved|Podfile\.lock)$|\.min\.(js|css)$|\.(map|vsix)$/;

type FileDiff = { path: string; summary: string; lines: string };

function parse(diff: string): FileDiff[] {
  return diff.split(/^(?=diff --git )/m).filter(part => part.startsWith('diff --git ')).map(part => {
    const lines = part.split('\n');
    const header = lines[0].match(/^diff --git a\/(.*) b\/(.*)$/);
    const path = header?.[2] ?? lines[0].slice('diff --git '.length);
    const status = /^new file mode/m.test(part) ? 'added' : /^deleted file mode/m.test(part) ? 'deleted'
      : /^rename from /m.test(part) ? `renamed from ${header?.[1] ?? '?'}` : 'modified';
    const hunks = lines.filter(line => /^(@@|[+-](?!\+\+ |-- ))/.test(line));
    const added = hunks.filter(line => line.startsWith('+')).length;
    const removed = hunks.filter(line => line.startsWith('-')).length;
    const binary = /^Binary files /m.test(part);
    const omit = binary || opaque.test(path);
    const counts = binary ? 'binary' : `+${added} -${removed}`;
    return { path, summary: `- ${path} (${status}, ${counts}${omit && !binary ? ', content omitted' : ''})`, lines: omit ? '' : hunks.join('\n') };
  });
}

/** A file list followed by changed lines only (no context lines), shared fairly between files and never longer than `budget`. */
export function compactDiff(diff: string, budget: number): string {
  const files = parse(diff);
  if (!files.length) return '';
  let list = 'Changed files:\n';
  for (const [index, file] of files.entries()) {
    const more = `... and ${files.length - index} more files\n`;
    if (list.length + file.summary.length + 1 + more.length > budget / 2 && index < files.length - 1) { list += more; break; }
    list += file.summary + '\n';
  }
  list = list.slice(0, budget);
  // Smallest first, so space a short file does not need goes to the larger ones.
  const shown = files.filter(file => file.lines).sort((a, b) => a.lines.length - b.lines.length);
  let remaining = budget - list.length;
  const sections = new Map<FileDiff, string>();
  for (const [index, file] of shown.entries()) {
    const share = Math.floor(remaining / (shown.length - index));
    const heading = `\n${file.path}\n`;
    if (share <= heading.length + 20) continue;
    const room = share - heading.length;
    const body = file.lines.length <= room ? file.lines : `${file.lines.slice(0, room - 12).replace(/\n[^\n]*$/, '')}\n[truncated]`;
    sections.set(file, heading + body);
    remaining -= heading.length + body.length;
  }
  return list + files.map(file => sections.get(file) ?? '').join('');
}

/** Normalizes the model's fields into `type(scope): subject` with an optional bullet body. */
export function formatCommit(fields: CommitFields): string {
  const line = (text: string) => text.replace(/\s+/g, ' ').trim();
  const type = (commitTypes as readonly string[]).includes(fields.commitType) ? fields.commitType : 'chore';
  const scope = line(fields.scope).toLowerCase().replace(/^\(|\)$/g, '');
  // Drop a type prefix the model may repeat, and lowercase "Add" but not acronyms such as "API".
  const subject = line(fields.subject).replace(new RegExp(`^(${commitTypes.join('|')})(\\([^)]*\\))?!?:\\s*`, 'i'), '').replace(/[.。]+$/, '').replace(/^[A-Z](?=[a-z])/, letter => letter.toLowerCase());
  if (!subject) throw new Error('empty subject');
  const body = fields.body.map(item => line(item).replace(/^([-*・•]|\d+[.)])\s*/, '')).filter(Boolean);
  const head = `${type}${/^[\w./-]{1,30}$/.test(scope) ? `(${scope})` : ''}: ${subject}`;
  return body.length ? `${head}\n\n${body.map(item => `- ${item}`).join('\n')}` : head;
}
