(() => {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const prompt = $('prompt');
  let state = { busy: false, ready: false, messages: [] };
  prompt.value = vscode.getState()?.draft || '';
  let dropRead = 0;
  const send = type => { if (['reset', 'stop', 'attachImage', 'removeImage'].includes(type)) ++dropRead; vscode.postMessage({ type }); };
  // Grow with content up to the CSS max-height instead of showing a resize handle.
  function fit() { prompt.style.height = 'auto'; prompt.style.height = `${prompt.scrollHeight}px`; }
  function showDiagnostics(open) { $('diagnostics').hidden = !open; $('status-toggle').setAttribute('aria-expanded', String(open)); }
  function controls() {
    $('send').disabled = state.busy || !state.ready || (!prompt.value.trim() && !state.image);
    $('stop').hidden = !state.busy;
    $('send').hidden = state.busy;
    $('refresh').disabled = state.busy;
    $('attach-image').disabled = state.busy || !state.ready || !state.imagesSupported;
  }
  // Model output is always text, never trusted HTML. Fenced code gets a pre block;
  // with markdown on, a small subset is built as DOM nodes so nothing is parsed as HTML.
  function content(parent, text, markdown) {
    const parts = text.split(/```[^\n]*\n([\s\S]*?)(?:```|$)/g);
    parts.forEach((part, index) => {
      if (!part) return;
      if (markdown && index % 2 === 0) { blocks(parent, part); return; }
      const node = document.createElement(index % 2 ? 'pre' : 'div');
      node.className = 'body-text'; node.textContent = part; parent.append(node);
    });
  }
  // Headings, bullet/numbered lists, rules and paragraphs. Unclosed markers stay literal,
  // so text mid-stream reads naturally until the closing marker arrives.
  function blocks(parent, text) {
    let paragraph = null, list = null;
    const close = () => { paragraph = null; list = null; };
    for (const line of text.split('\n')) {
      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
      const item = line.match(/^(\s*)([*+-]|\d+[.)])\s+(.*)$/);
      if (!line.trim()) { close(); continue; }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { close(); parent.append(document.createElement('hr')); continue; }
      if (heading) {
        close(); const node = document.createElement('div');
        node.className = `md-heading md-h${heading[1].length}`; inline(node, heading[2]); parent.append(node); continue;
      }
      if (item) {
        const ordered = /\d/.test(item[2]);
        const nested = list && item[1].replace(/\t/g, '  ').length >= 2;
        const owner = nested ? (list.sub?.parentNode === list.lastChild ? list.sub : null) : list;
        let target = owner && owner.ordered === ordered ? owner : null;
        if (!target) {
          paragraph = null; target = document.createElement(ordered ? 'ol' : 'ul'); target.ordered = ordered;
          if (ordered && parseInt(item[2], 10) !== 1) target.start = parseInt(item[2], 10);
          if (nested) { list.lastChild.append(target); list.sub = target; } else { parent.append(target); list = target; }
        }
        const node = document.createElement('li');
        inline(node, item[3]); target.append(node); continue;
      }
      if (list && /^\s+\S/.test(line)) { const last = list.lastChild; last.append(document.createElement('br')); inline(last, line.trim()); continue; }
      list = null;
      if (paragraph) paragraph.append(document.createElement('br'));
      else { paragraph = document.createElement('p'); paragraph.className = 'md-paragraph'; parent.append(paragraph); }
      inline(paragraph, line);
    }
  }
  function inline(parent, text) {
    const pattern = /`([^`\n]+)`|\*\*(?=\S)(.*?\S)\*\*|__(?=\S)(.*?\S)__|(?<![\w*])\*(?=[^\s*])(.*?[^\s*])\*(?!\*)/g;
    let last = 0, match;
    while ((match = pattern.exec(text))) {
      parent.append(text.slice(last, match.index)); last = pattern.lastIndex;
      if (match[1] !== undefined) { const code = document.createElement('code'); code.textContent = match[1]; parent.append(code); continue; }
      const node = document.createElement(match[4] !== undefined ? 'em' : 'strong');
      inline(node, match[2] ?? match[3] ?? match[4]); parent.append(node);
    }
    parent.append(text.slice(last));
  }
  const notes = { generating: '選択テキストを処理中…', generated: '差分を確認してから適用できます。', previewed: '差分を開きました。内容を確認して適用してください。', applying: '適用中…', applied: '適用しました。元に戻すにはエディタでUndo。', stale: '元の文章が変更されたか閉じられました。選択し直して実行してください。', failed: '生成が完了しなかったため適用できません。', discarded: 'この候補は破棄しました。' };
  function article(message, index) {
    const node = document.createElement('article'); node.className = message.role;
    const heading = document.createElement('div'); heading.className = 'message-heading';
    const label = document.createElement('strong'); label.textContent = message.role === 'user' ? 'あなた' : 'LOCAL FM';
    heading.append(label);
    if (message.text) {
      const copy = document.createElement('button'); copy.className = 'quiet'; copy.textContent = 'コピー';
      copy.setAttribute('aria-label', `${index + 1}番目のメッセージをコピー`);
      copy.onclick = () => vscode.postMessage({ type: 'copy', index }); heading.append(copy);
    }
    node.append(heading);
    if (message.image) { const image = document.createElement('img'); image.className = 'message-image'; image.src = `data:${message.image.mime};base64,${message.image.data}`; image.alt = message.image.name; node.append(image); }
    content(node, message.text || (state.busy ? '考えています…' : '応答はありません。'), message.role === 'assistant' && !!message.text);
    if (message.edit) {
      const edit = message.edit;
      const actions = document.createElement('div'); actions.className = 'edit-actions';
      const note = document.createElement('small'); note.textContent = `${edit.label} · ${notes[edit.state] || ''}`; actions.append(note);
      const button = (label, type) => {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.onclick = () => vscode.postMessage({ type, id: edit.id }); actions.append(button);
      };
      if (['generated', 'previewed'].includes(edit.state)) button('差分を見る', 'previewEdit');
      if (edit.state === 'previewed') button('選択範囲に適用', 'applyEdit');
      if (['generated', 'previewed', 'stale', 'failed'].includes(edit.state)) button('破棄', 'discardEdit');
      node.append(actions);
    }
    if (message.note) { const note = document.createElement('small'); note.textContent = message.note; node.append(note); }
    if (message.incomplete && !state.busy) { const note = document.createElement('small'); note.textContent = '未完了 · 次の会話には含まれません'; node.append(note); }
    return node;
  }
  // Unchanged messages keep their DOM nodes, so text selection and focus in earlier
  // messages survive streaming; only messages whose rendered inputs changed are rebuilt.
  let rendered = [];
  function renderMessages() {
    const scroller = $('conversation');
    const stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    $('welcome').hidden = state.messages.length > 0;
    state.messages.forEach((message, index) => {
      const key = JSON.stringify([message, !message.text && state.busy, message.incomplete && state.busy]);
      if (rendered[index]?.key === key) return;
      const node = article(message, index);
      if (rendered[index]) rendered[index].node.replaceWith(node); else $('messages').append(node);
      rendered[index] = { key, node };
    });
    for (const extra of rendered.splice(state.messages.length)) extra.node.remove();
    if (stick) scroller.scrollTop = scroller.scrollHeight;
  }
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'accepted') { prompt.value = ''; vscode.setState({ draft: '' }); fit(); controls(); return; }
    if (data.type === 'diagnosticsCopied') { $('copy-status').textContent = 'コピーしました'; return; }
    if (data.type === 'snapshot') {
      const message = state.messages?.[data.index];
      if (message && typeof data.text === 'string') { message.text = data.text; renderMessages(); }
      return;
    }
    if (data.type !== 'state') return;
    state = data;
    if (state.busy || !state.ready || !state.imagesSupported) $('drop-hint').hidden = true;
    $('status').textContent = data.status;
    $('dot').className = data.diagnostics?.code ? 'problem' : (data.ready ? 'online' : '');
    const diagnostic = data.diagnostics || {};
    const time = value => value ? new Date(value).toLocaleString() : '未実施';
    $('availability').textContent = `利用可否: ${diagnostic.availability === 'available' ? '利用可能' : diagnostic.availability === 'unavailableOrFailed' ? '利用不可または確認失敗' : '未確認'}（確認: ${time(diagnostic.lastCheckedAt)}）`;
    $('response-check').textContent = diagnostic.lastResponseAt ? `最後に応答が完了した日時: ${time(diagnostic.lastResponseAt)}` : '応答実績: この起動中はまだ未確認です。メッセージを送信して確認できます。';
    $('recovery').hidden = !diagnostic.guidance;
    $('recovery').textContent = diagnostic.guidance || '';
    $('error-code').hidden = !diagnostic.code;
    $('error-code').textContent = diagnostic.code ? `診断分類: ${diagnostic.code}` : '';
    if (diagnostic.code) showDiagnostics(true);
    $('copy-status').textContent = '';
    renderMessages();
    $('attachment').hidden = !data.attachment;
    $('attachment').querySelector('span').textContent = `選択テキスト · ${data.attachment.length.toLocaleString()}文字`;
    $('attachment').title = data.attachment;
    $('image-attachment').hidden = !data.image;
    if (data.image) { $('image-preview').src = `data:${data.image.mime};base64,${data.image.data}`; $('image-name').textContent = data.image.name; }
    else { $('image-preview').removeAttribute('src'); $('image-name').textContent = ''; }
    $('image-support').textContent = data.imagesSupported ? 'PNG / JPEG・10 MBまで。ファイル一覧からはShift＋ドロップ' : '画像入力にはmacOS 27以降と対応ビルドが必要です';
    controls();
  });
  $('composer').onsubmit = event => {
    event.preventDefault();
    if (!state.busy && state.ready && (prompt.value.trim() || state.image)) vscode.postMessage({ type: 'send', text: prompt.value });
  };
  prompt.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault(); $('composer').requestSubmit();
    }
  });
  prompt.addEventListener('input', () => { vscode.setState({ draft: prompt.value }); fit(); controls(); });
  $('status-toggle').onclick = () => showDiagnostics($('diagnostics').hidden);
  for (const [id, type] of [['attach-image', 'attachImage'], ['remove-image', 'removeImage'], ['reset', 'reset'], ['refresh', 'refresh'], ['stop', 'stop'], ['attach', 'attach'], ['remove', 'removeAttachment'], ['copy-diagnostics', 'copyDiagnostics']]) $(id).onclick = () => send(type);
  document.querySelectorAll('[data-prompt]').forEach(button => button.onclick = () => {
    prompt.value = button.dataset.prompt; prompt.dispatchEvent(new Event('input')); prompt.focus();
  });
  // Finder supplies File bytes; the VS Code Explorer supplies resource URIs.
  // Never interpret ordinary dragged text as a filesystem path.
  const dropTypes = ['Files', 'text/uri-list', 'resourceurls'];
  const fileDrag = event => dropTypes.some(type => Array.from(event.dataTransfer?.types || []).some(t => t.toLowerCase() === type.toLowerCase()));
  let dragDepth = 0;
  const canDrop = () => state.ready && state.imagesSupported && !state.busy;
  const clearDrag = () => { dragDepth = 0; $('drop-hint').hidden = true; };
  document.addEventListener('dragenter', event => {
    if (!fileDrag(event)) return;
    event.preventDefault(); ++dragDepth;
    $('drop-hint').textContent = canDrop() ? '画像をドロップして添付' : '画像を添付できません。生成中の場合は完了をお待ちください。';
    $('drop-hint').hidden = false;
  });
  document.addEventListener('dragover', event => {
    if (!fileDrag(event)) return;
    event.preventDefault(); event.stopPropagation();
    event.dataTransfer.dropEffect = canDrop() ? 'copy' : 'none';
  });
  document.addEventListener('dragleave', event => {
    if (fileDrag(event) && --dragDepth <= 0) clearDrag();
  });
  document.addEventListener('dragend', clearDrag);
  window.addEventListener('blur', clearDrag);
  document.addEventListener('drop', async event => {
    if (!fileDrag(event)) return;
    event.preventDefault(); event.stopPropagation(); clearDrag();
    if (!canDrop()) return;
    const read = ++dropRead;
    const token = state.imageToken;
    const current = () => read === dropRead && token === state.imageToken && canDrop();
    try {
      const transfer = event.dataTransfer;
      const files = Array.from(transfer.files);
      if (files.length) {
        if (files.length !== 1 || !files[0].size || files[0].size > 10 * 1024 * 1024 || !/\.(png|jpe?g)$/i.test(files[0].name)) throw new Error('Unsupported file');
        const file = files[0];
        const dataURL = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reader.onabort = () => reject(new Error('Read failed'));
          reader.readAsDataURL(file);
        });
        if (current()) vscode.postMessage({ type: 'dropImage', token, image: { name: file.name, data: dataURL.slice(dataURL.indexOf(',') + 1) } });
      } else {
        const resources = transfer.getData('resourceurls');
        const uris = resources ? JSON.parse(resources) : transfer.getData('text/uri-list').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
        if (!Array.isArray(uris) || uris.length !== 1 || typeof uris[0] !== 'string') throw new Error('Drop one image');
        vscode.postMessage({ type: 'dropImage', token, uri: uris[0] });
      }
    } catch { if (current()) vscode.postMessage({ type: 'dropImageError', token }); }
  });
  fit(); controls(); send('ready');
})();
