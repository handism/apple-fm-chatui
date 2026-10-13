const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ollamaChat, OllamaError } = require('../dist/ollama');

function stream(lines) {
  const encoder = new TextEncoder();
  return new ReadableStream({ start(controller) { for (const line of lines) controller.enqueue(encoder.encode(line)); controller.close(); } });
}
async function withFetch(handler, run) {
  const original = global.fetch;
  global.fetch = handler;
  try { await run(); } finally { global.fetch = original; }
}

test('streams split NDJSON chunks and sends system prompt, history and images', async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url: String(url), body: init.body && JSON.parse(init.body) });
    if (String(url).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'first:latest' }, { name: 'second' }] }));
    return new Response(stream(['{"message":{"content":"Hel"}}\n{"message":{"con', 'tent":"lo"}}\n', '{"message":{"content":""},"done":true}\n']));
  }, async () => {
    const events = [];
    const image = { name: 'a.png', mime: 'image/png', data: 'AAAA' };
    await ollamaChat('http://localhost:11434', '', { prompt: 'q', history: [{ role: 'user', text: 'p', image }, { role: 'assistant', text: 'a' }] }, event => events.push(event)).done;
    assert.deepEqual(events, [{ type: 'model', name: 'first:latest' }, { type: 'snapshot', text: 'Hel' }, { type: 'snapshot', text: 'Hello' }]);
    assert.equal(calls[1].url, 'http://localhost:11434/api/chat');
    const { model, stream: streaming, messages } = calls[1].body;
    assert.equal(model, 'first:latest'); assert.equal(streaming, true);
    assert.equal(messages[0].role, 'system');
    assert.deepEqual(messages.slice(1), [{ role: 'user', content: 'p', images: ['AAAA'] }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'q' }]);
  });
});

test('reports connection failures, server errors, truncated streams and missing models in user-facing terms', async () => {
  const run = (handler, model = 'm') => withFetch(handler, () => ollamaChat('http://localhost:11434', model, { prompt: 'q', history: [] }, () => {}).done);
  await assert.rejects(run(async () => { throw new TypeError('fetch failed'); }), error => error instanceof OllamaError && /接続できません/.test(error.message));
  await assert.rejects(run(async () => new Response(JSON.stringify({ error: "model 'm' not found" }), { status: 404 })), /404.*not found/);
  await assert.rejects(run(async () => new Response(stream(['{"error":"out of memory"}\n']))), /out of memory/);
  await assert.rejects(run(async () => new Response(stream(['{"message":{"content":"partial"}}\n']))), /途中で終了/);
  await assert.rejects(run(async () => new Response(JSON.stringify({ models: [] })), ''), /ollama pull/);
});

test('cancel aborts the request', async () => {
  await withFetch((url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))), async () => {
    const job = ollamaChat('http://localhost:11434', 'm', { prompt: 'q', history: [] }, () => {});
    job.cancel();
    await assert.rejects(job.done, /停止しました/);
  });
});
