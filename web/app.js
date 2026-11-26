const $ = (id) => document.getElementById(id);
const welcomeHtml = $('messages').innerHTML;

const DEFAULT_MODEL_OPTIONS = [
  { value: 'gidra-code-auto', label: 'Gidra Code Auto (для кода)' },
  { value: 'gidra-auto', label: 'Gidra Auto' },
  { value: 'hydra-gpt-mini', label: 'Hydra GPT Mini (дешевле)' },
  { value: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
  { value: 'demo-model', label: 'Демо (без ключа)' },
];

const DEFAULT_ROLES = [
  {
    id: 'coder',
    name: 'Программист',
    description: 'Пишет и редактирует код в папке workspace, запускает простые проверки.',
    instructions:
      'Ты — программист. Работай только внутри папки workspace. Для поиска файлов используй list_files и search, для чтения больших файлов — read с offset/limit, для точечных правок — edit вместо полной перезаписи через write. Кратко сообщай, что изменил.',
    model: 'gidra-code-auto',
    enabled: true,
    tools: ['read', 'edit', 'write', 'delete_file', 'list_files', 'search', 'fetch_page', 'bash'],
  },
  {
    id: 'reviewer',
    name: 'Проверяющий',
    description: 'Проверяет код на ошибки, баги и крайние случаи без изменения файлов.',
    instructions:
      'Ты — внимательный проверяющий (код-ревьюер). Используй list_files, search и read (с offset/limit для больших файлов), при необходимости запусти проверку через bash и коротко перечисли найденные проблемы. Не изменяй файлы.',
    model: 'hydra-gpt-mini',
    enabled: true,
    tools: ['read', 'list_files', 'search', 'bash'],
  },
  {
    id: 'docs',
    name: 'Писатель документации',
    description: 'Пишет понятные README, инструкции и комментарии к коду на русском языке.',
    instructions:
      'Ты — автор документации. Пиши простые, понятные инструкции и комментарии к коду на русском языке, ориентируясь на новичка. Сначала изучи файлы через list_files/read, затем обнови нужный документ через edit или write.',
    model: 'hydra-gpt-mini',
    enabled: false,
    tools: ['read', 'edit', 'write', 'list_files', 'search', 'fetch_page'],
  },
];

function upgradeRoleTools(tools) {
  const set = new Set(Array.isArray(tools) ? tools : ['read']);
  if (set.has('read')) {
    set.add('list_files');
    set.add('search');
  }
  if (set.has('write')) {
    set.add('edit');
    set.add('delete_file');
  }
  return [...set];
}

function loadStoredRoles() {
  try {
    const raw = localStorage.getItem('harness.roles');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.map((role) => ({ ...role, tools: upgradeRoleTools(role.tools) }));
      }
    }
  } catch {
    // ignore corrupted storage
  }
  return DEFAULT_ROLES.map((role) => ({ ...role, tools: [...role.tools] }));
}

function loadStoredModels() {
  try {
    const raw = localStorage.getItem('harness.models');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.map((id) => ({ value: id, label: id }));
      }
    }
  } catch {
    // ignore corrupted storage
  }
  return DEFAULT_MODEL_OPTIONS;
}

const DEFAULT_TEMPLATES = [
  { id: 'tpl-check', label: '🔍 Проверь ошибки', prompt: 'Проверь файлы в песочнице на ошибки и подскажи, что можно улучшить.' },
  { id: 'tpl-site', label: '✨ Сделай сайт', prompt: 'Создай аккуратную HTML-страницу с современным дизайном в workspace.' },
  { id: 'tpl-run', label: '📖 Как запустить?', prompt: 'Посмотри файлы в песочнице и объясни простыми словами, как запустить эту программу.' },
];

function loadStoredTemplates() {
  try {
    const raw = localStorage.getItem('harness.templates');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch {
    // ignore
  }
  return DEFAULT_TEMPLATES.map((t) => ({ ...t }));
}

const state = {
  apiKey: localStorage.getItem('harness.apiKey') || '',
  model: localStorage.getItem('harness.model') || 'gidra-code-auto',
  demo: localStorage.getItem('harness.demo') === null ? !localStorage.getItem('harness.apiKey') : localStorage.getItem('harness.demo') === '1',
  mode: localStorage.getItem('harness.mode') === 'plan' ? 'plan' : 'act',
  rules: localStorage.getItem('harness.rules') ?? 'Пиши максимально простой и понятный код. Объясняй по-русски без сложного жаргона.',
  templates: loadStoredTemplates(),
  sessionId: null,
  lastCheckpointId: null,
  contextTokens: 0,
  sessionTokens: 0,
  busy: false,
  controller: null,
  files: [],
  roles: loadStoredRoles(),
  modelOptions: mergeCustomStoredModels(loadStoredModels()),
  editingRoleId: null,
  skills: [],
  editingSkillName: null,
  lastRefinedPrompt: '',
};

function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, 4000);
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Ошибка ${response.status}`);
  return data;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function formatInline(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function renderMarkdown(text) {
  if (!text) return '';
  return escapeHtml(text)
    .split('```')
    .map((part, index) => {
      if (index % 2 === 1) {
        if (/^prompt\s*\n/i.test(part)) {
          const clean = part.replace(/^prompt\s*\n/i, '').trim();
          state.lastRefinedPrompt = clean.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
          return [
            '<div class="prompt-card">',
            '<div class="prompt-card-title">✨ Готовый улучшенный запрос</div>',
            `<div class="prompt-card-text">${clean}</div>`,
            '<div class="prompt-card-actions">',
            '<button type="button" class="prompt-card-btn" data-prompt-action="use">📋 Вставить в поле</button>',
            '<button type="button" class="prompt-card-btn" data-prompt-action="sharpen">🎯 Углубить через /sharpen</button>',
            '<button type="button" class="prompt-card-btn primary" data-prompt-action="run">⚡ Запустить в Действии</button>',
            '</div>',
            '</div>',
          ].join('');
        }
        return `<pre><code>${part.replace(/^\w+\n/, '').replace(/^\n/, '')}</code></pre>`;
      }
      return part.split('\n').map(formatInline).join('<br>');
    })
    .join('');
}

function scrollToBottom() {
  $('messages').scrollTop = $('messages').scrollHeight;
}

function addMessage(role, text, { streaming = false } = {}) {
  const welcome = $('messages').querySelector('.welcome');
  if (welcome) welcome.remove();
  const wrapper = document.createElement('div');
  wrapper.className = `message ${role}`;
  if (role === 'assistant') {
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = '✦';
    wrapper.appendChild(avatar);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const activity = document.createElement('div');
  const textElement = document.createElement('div');
  if (streaming) {
    activity.className = 'activity-collection';
    bubble.appendChild(activity);
    textElement.textContent = 'Думаю…';
    textElement.style.color = 'var(--muted)';
  } else {
    textElement.innerHTML = renderMarkdown(text);
  }
  bubble.appendChild(textElement);
  wrapper.appendChild(bubble);
  $('messages').appendChild(wrapper);
  scrollToBottom();
  return { wrapper, bubble, textElement, activity };
}

function appendActivity(target, text, detail) {
  const line = document.createElement('div');
  line.className = 'activity';
  line.textContent = text;
  if (detail) {
    const small = document.createElement('span');
    small.className = 'detail';
    small.textContent = detail;
    line.appendChild(small);
  }
  target.appendChild(line);
  scrollToBottom();
}

function addNotice(text) {
  const element = document.createElement('div');
  element.className = 'notice';
  element.textContent = text;
  $('messages').appendChild(element);
  scrollToBottom();
}

function setBusy(busy) {
  state.busy = busy;
  $('sendButton').disabled = busy;
  $('stopButton').hidden = !busy;
}

async function readSse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const line = chunk.split('\n').find((item) => item.startsWith('data: '));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(6)));
      } catch (error) {
        console.error('Не удалось прочитать событие', error);
      }
    }
  }
}

async function sendMessage(promptText) {
  if (state.busy) return;
  const prompt = (promptText ?? $('prompt').value).trim();
  if (!prompt) return;
  if (!state.demo && !state.apiKey.trim()) {
    toast('Вставь ключ HydraAI в левой панели и нажми «Сохранить»');
    $('apiKey').focus();
    return;
  }
  $('prompt').value = '';
  addMessage('user', prompt);
  const assistant = addMessage('assistant', '', { streaming: true });
  setBusy(true);
  const controller = new AbortController();
  state.controller = controller;
  let fullText = '';

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt,
        apiKey: state.apiKey,
        model: state.model,
        demo: state.demo,
        mode: state.mode,
        rules: state.rules,
        sessionId: state.sessionId,
        roles: state.roles,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Не удалось отправить сообщение');
    }
    assistant.textElement.textContent = '';
    assistant.textElement.style.color = '';

    await readSse(response, (event) => {
      switch (event.type) {
        case 'started':
          state.sessionId = event.sessionId;
          $('compactButton').hidden = false;
          markActiveSession();
          break;
        case 'skill':
          appendActivity(
            assistant.activity,
            `${event.skill.icon} Навык /${event.skill.name} — ${event.skill.title}`,
            event.skill.mode === 'plan' ? 'Включён безопасный режим без изменения файлов' : '',
          );
          break;
        case 'text':
          fullText += event.text;
          assistant.textElement.textContent = fullText;
          scrollToBottom();
          break;
        case 'activity':
          appendActivity(assistant.activity, event.text, event.detail);
          break;
        case 'ask_user':
          renderAskUserCard(event.requestId, event.questions, assistant);
          break;
        case 'notice':
          addNotice(event.text);
          break;
        case 'error':
          toast(event.message);
          appendActivity(assistant.activity, `Ошибка: ${event.message}`);
          break;
        case 'checkpoint':
          state.lastCheckpointId = event.checkpointId;
          break;
        case 'done':
          state.sessionId = event.result.sessionId;
          state.lastCheckpointId = event.result.checkpointId || state.lastCheckpointId;
          if (event.result.changes) renderChanges(event.result.changes);
          if (event.files) {
            state.files = event.files;
            renderFiles();
          }
          if (typeof event.result.contextTokens === 'number') {
            state.contextTokens = event.result.contextTokens;
          }
          if (event.result.sessionUsage && typeof event.result.sessionUsage.totalTokens === 'number') {
            state.sessionTokens = event.result.sessionUsage.totalTokens;
          }
          updateTokenBadge();
          if (event.result.usage && event.result.usage.totalTokens > 0) {
            const note = document.createElement('div');
            note.className = 'usage-note';
            note.textContent = `📊 Ответ: +${event.result.usage.totalTokens.toLocaleString('ru-RU')} ткн (вход ${event.result.usage.inputTokens.toLocaleString('ru-RU')} / выход ${event.result.usage.outputTokens.toLocaleString('ru-RU')})`;
            assistant.bubble.appendChild(note);
          }
          if (event.result.stopReason === 'error' && !fullText) {
            appendActivity(assistant.activity, 'Задача не выполнена. Проверь ключ и попробуй ещё раз.');
          } else if (event.result.stopReason === 'loop_detected' && !fullText) {
            fullText =
              'Кажется, я хожу по кругу — остановился, чтобы не тратить лишние токены. Подскажи, пожалуйста, как лучше действовать, или начни новый чат.';
            assistant.textElement.textContent = fullText;
          } else if (event.result.stopReason === 'max_turns' && !fullText) {
            fullText =
              'Достигнут лимит шагов для одной задачи. Если нужно продолжить — напиши, что делать дальше, или начни новый чат.';
            assistant.textElement.textContent = fullText;
          }
          markActiveSession();
          loadSessions();
          break;
      }
    });
  } catch (error) {
    if (controller.signal.aborted) {
      appendActivity(assistant.activity, 'Остановлено');
    } else {
      assistant.bubble.classList.add('error-bubble');
      assistant.textElement.textContent = `Не получилось: ${error.message}`;
      toast(error.message);
    }
  } finally {
    if (fullText) assistant.textElement.innerHTML = renderMarkdown(fullText);
    setBusy(false);
    scrollToBottom();
  }
}

function renderAskUserCard(requestId, questions, assistant) {
  const card = document.createElement('div');
  card.className = 'ask-card';
  const selections = new Map();

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const block = document.createElement('div');
    block.className = 'ask-question';

    const title = document.createElement('div');
    title.className = 'ask-title';
    title.textContent = `${qi + 1}. ${q.question}`;
    block.appendChild(title);

    const optionsWrap = document.createElement('div');
    optionsWrap.className = 'ask-options';

    let customInput = null;
    const optionButtons = [];

    for (const opt of q.options || []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ask-option';

      const label = document.createElement('div');
      label.className = 'ask-option-label';
      label.textContent = opt.label;
      btn.appendChild(label);

      if (opt.description) {
        const desc = document.createElement('div');
        desc.className = 'ask-option-desc';
        desc.textContent = opt.description;
        btn.appendChild(desc);
      }

      btn.addEventListener('click', () => {
        for (const item of optionButtons) item.classList.remove('selected');
        btn.classList.add('selected');
        selections.set(q.id, { questionId: q.id, selectedOptionId: opt.id, customResponse: null, label: opt.label });
        if (customInput) customInput.value = '';
        updateSubmitState();
      });
      optionButtons.push(btn);
      optionsWrap.appendChild(btn);
    }
    block.appendChild(optionsWrap);

    if (q.allowCustomResponse !== false) {
      customInput = document.createElement('input');
      customInput.type = 'text';
      customInput.className = 'field ask-custom';
      customInput.placeholder = 'Или напиши свой вариант…';
      customInput.addEventListener('input', () => {
        const text = customInput.value.trim();
        if (text) {
          for (const item of optionButtons) item.classList.remove('selected');
          selections.set(q.id, { questionId: q.id, selectedOptionId: null, customResponse: text, label: text });
        } else if (selections.get(q.id)?.customResponse) {
          selections.delete(q.id);
        }
        updateSubmitState();
      });
      block.appendChild(customInput);
    }

    card.appendChild(block);
  }

  const actions = document.createElement('div');
  actions.className = 'ask-actions';
  const skipBtn = document.createElement('button');
  skipBtn.type = 'button';
  skipBtn.className = 'button button-secondary';
  skipBtn.textContent = 'Пропустить';
  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'button button-primary';
  submitBtn.textContent = 'Отправить ответы';
  submitBtn.disabled = true;

  function updateSubmitState() {
    submitBtn.disabled = selections.size === 0;
  }

  async function finish(skipped) {
    skipBtn.disabled = true;
    submitBtn.disabled = true;
    card.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
    const answers = skipped
      ? []
      : questions.map((q) => {
          const picked = selections.get(q.id);
          return picked
            ? { questionId: q.id, selectedOptionId: picked.selectedOptionId, customResponse: picked.customResponse }
            : { questionId: q.id, selectedOptionId: null, customResponse: null };
        });
    try {
      await api('/api/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, answers, skipped }),
      });
      const summary = document.createElement('div');
      summary.className = 'ask-summary';
      if (skipped) {
        summary.textContent = 'Вопросы пропущены — помощник продолжает.';
      } else {
        const labels = [...selections.values()].map((item) => item.label).filter(Boolean);
        summary.textContent = `✓ Выбрано: ${labels.join(' · ')}`;
      }
      actions.replaceWith(summary);
      scrollToBottom();
    } catch (error) {
      toast(error.message);
    }
  }

  skipBtn.addEventListener('click', () => finish(true));
  submitBtn.addEventListener('click', () => finish(false));
  actions.appendChild(skipBtn);
  actions.appendChild(submitBtn);
  card.appendChild(actions);

  assistant.activity.appendChild(card);
  scrollToBottom();
}

function renderChanges(changes) {
  const container = $('changes');
  container.innerHTML = '';
  if (!changes || !changes.length) {
    container.className = 'changes-empty';
    container.textContent = 'В этой задаче файлы не менялись.';
  } else {
    container.className = '';
    for (const change of changes) {
      const card = document.createElement('div');
      card.className = 'change-card';
      const path = document.createElement('div');
      path.className = 'change-path';
      const icon = change.after === null ? '🗑 ' : change.before === null ? '＋ ' : '✎ ';
      path.textContent = `${icon}${change.path}`;
      card.appendChild(path);
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.className = 'change-preview';
      summary.textContent = 'Посмотреть содержимое';
      const preview = document.createElement('div');
      preview.className = 'change-preview';
      preview.textContent = change.after === null ? '(файл удалён)' : change.after.slice(0, 300);
      details.appendChild(summary);
      details.appendChild(preview);
      card.appendChild(details);
      container.appendChild(card);
    }
  }
  $('rollbackButton').hidden = !state.lastCheckpointId;
}

async function renderCheckpoints(checkpoints) {
  if (checkpoints && checkpoints.length) {
    state.lastCheckpointId = checkpoints[checkpoints.length - 1].id;
    const last = checkpoints[checkpoints.length - 1];
    renderChanges(last.changes);
  } else {
    state.lastCheckpointId = null;
    $('changes').className = 'changes-empty';
    $('changes').textContent = 'Пока нет изменений. После задачи здесь появится список файлов.';
    $('rollbackButton').hidden = true;
  }
}

function renderFiles() {
  const list = $('fileList');
  list.innerHTML = '';
  const hasHtml = state.files.some((file) => /\.html?$/i.test(file.path));
  $('previewSiteLink').hidden = !hasHtml;
  if (!state.files.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-small';
    empty.textContent = 'Папка пуста';
    list.appendChild(empty);
    return;
  }
  for (const file of state.files) {
    const button = document.createElement('button');
    button.className = 'list-item';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `📄 ${file.path}`;
    const size = document.createElement('span');
    size.className = 'meta';
    size.textContent = `${Math.max(1, Math.round(file.size / 1024))} КБ`;
    button.appendChild(name);
    button.appendChild(size);
    button.addEventListener('click', () => openFile(file.path));
    list.appendChild(button);
  }
}

async function openFile(filePath) {
  try {
    const data = await api(`/api/file?path=${encodeURIComponent(filePath)}`);
    $('fileModalTitle').textContent = data.path;
    $('fileModalContent').textContent = data.content;
    const isHtml = /\.html?$/i.test(filePath);
    $('previewFileLink').hidden = !isHtml;
    if (isHtml) {
      $('previewFileLink').href = `/preview/${filePath.split('/').map(encodeURIComponent).join('/')}`;
    }
    $('downloadFileLink').href = `/api/download?path=${encodeURIComponent(filePath)}`;
    $('downloadFileLink').download = filePath.split('/').pop() || 'file.txt';
    $('fileModal').hidden = false;
  } catch (error) {
    toast(error.message);
  }
}

async function loadFiles() {
  try {
    const data = await api('/api/files');
    state.files = data.files;
    renderFiles();
  } catch (error) {
    toast(error.message);
  }
}

async function loadSessions() {
  try {
    const data = await api('/api/sessions');
    const list = $('sessionList');
    list.innerHTML = '';
    if (!data.sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-small';
      empty.textContent = 'Пока нет чатов';
      list.appendChild(empty);
      return;
    }
    for (const session of data.sessions) {
      const button = document.createElement('button');
      button.className = 'list-item' + (session.id === state.sessionId ? ' active' : '');
      button.dataset.sessionId = session.id;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = `💬 Чат ${session.id.slice(0, 8)}`;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = new Date(session.updatedAt).toLocaleDateString('ru-RU');
      button.appendChild(name);
      button.appendChild(meta);
      button.addEventListener('click', () => openSession(session.id));
      list.appendChild(button);
    }
  } catch (error) {
    toast(error.message);
  }
}

function markActiveSession() {
  document.querySelectorAll('#sessionList .list-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.sessionId === state.sessionId);
  });
}

async function openSession(id) {
  if (state.busy) return;
  try {
    const data = await api(`/api/session?id=${encodeURIComponent(id)}`);
    state.sessionId = data.session.id;
    state.contextTokens = data.session.contextTokens ?? 0;
    state.sessionTokens = data.session.usage?.totalTokens ?? 0;
    updateTokenBadge();
    $('compactButton').hidden = false;
    $('messages').innerHTML = '';
    const shown = data.session.messages.filter((message) => message.role === 'user' || (message.role === 'assistant' && message.content));
    if (!shown.length) addMessage('user', 'Новый чат');
    for (const message of shown) addMessage(message.role, message.content);
    await renderCheckpoints(data.session.checkpoints);
    $('chatTitle').textContent = `Чат ${id.slice(0, 8)}`;
    markActiveSession();
    scrollToBottom();
  } catch (error) {
    toast(error.message);
  }
}

function newChat() {
  if (state.busy) return;
  state.sessionId = null;
  state.lastCheckpointId = null;
  state.contextTokens = 0;
  state.sessionTokens = 0;
  updateTokenBadge();
  $('compactButton').hidden = true;
  $('messages').innerHTML = welcomeHtml;
  $('chatTitle').textContent = 'Новый чат';
  $('changes').className = 'changes-empty';
  $('changes').textContent = 'Пока нет изменений. После задачи здесь появится список файлов.';
  $('rollbackButton').hidden = true;
  $('prompt').focus();
  markActiveSession();
}

function saveSettings() {
  state.apiKey = $('apiKey').value.trim();
  state.demo = $('demoMode').checked;
  const option = $('model').options[$('model').selectedIndex];
  state.model = $('model').value || 'gidra-code-auto';
  localStorage.setItem('harness.apiKey', state.apiKey);
  localStorage.setItem('harness.model', state.model);
  localStorage.setItem('harness.demo', state.demo ? '1' : '0');
  $('modelBadge').textContent = state.demo ? 'демо-режим' : state.model;
  const status = $('connectionStatus');
  status.className = 'status' + (state.demo || state.apiKey ? ' ok' : '');
  if (state.demo) status.textContent = 'Демо-режим: ключ не нужен';
  else status.textContent = state.apiKey
    ? `Ключ сохранён в браузере · ${option ? option.text : state.model}`
    : 'Введите ключ, чтобы начать';
  toast('Настройки сохранены');
}

function saveRoles() {
  localStorage.setItem('harness.roles', JSON.stringify(state.roles));
  updateTeamBadge();
}

function updateTeamBadge() {
  const activeCount = state.roles.filter((role) => role.enabled).length;
  const badge = $('teamBadge');
  badge.textContent = activeCount > 0 ? `Команда: ${activeCount} вкл.` : 'Один агент';
  badge.className = activeCount > 0 ? 'badge' : 'badge badge-soft';
}

function describePermissions(tools) {
  const list = Array.isArray(tools) ? tools : [];
  if (list.includes('write') && list.includes('bash')) return 'код и проверки';
  if (list.includes('write')) return 'пишет файлы';
  if (list.includes('bash')) return 'чтение и проверки';
  return 'только чтение';
}

function registerModelOption(modelId) {
  const clean = (modelId || '').trim();
  if (!clean) return;
  if (!state.modelOptions.some((item) => item.value === clean)) {
    state.modelOptions.push({ value: clean, label: clean });
    try {
      const saved = JSON.parse(localStorage.getItem('harness.customModels') || '[]');
      if (Array.isArray(saved) && !saved.includes(clean)) {
        saved.push(clean);
        localStorage.setItem('harness.customModels', JSON.stringify(saved));
      }
    } catch {
      // ignore storage errors
    }
  }
  syncModelsDatalist();
}

function syncModelsDatalist() {
  const datalist = $('modelsDatalist');
  if (!datalist) return;
  datalist.innerHTML = '';
  for (const item of state.modelOptions) {
    const option = document.createElement('option');
    option.value = item.value;
    datalist.appendChild(option);
  }
}

function mergeCustomStoredModels(options) {
  const result = [...options];
  try {
    const custom = JSON.parse(localStorage.getItem('harness.customModels') || '[]');
    if (Array.isArray(custom)) {
      for (const id of custom) {
        if (typeof id === 'string' && id.trim() && !result.some((item) => item.value === id)) {
          result.push({ value: id, label: id });
        }
      }
    }
  } catch {
    // ignore
  }
  return result;
}

function populateSelectWithModels(select, selectedValue) {
  select.innerHTML = '';
  for (const item of state.modelOptions) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    select.appendChild(option);
  }
  if (selectedValue && selectedValue !== '__custom__' && ![...select.options].some((o) => o.value === selectedValue)) {
    const extra = document.createElement('option');
    extra.value = selectedValue;
    extra.textContent = selectedValue;
    select.appendChild(extra);
  }
  const customOpt = document.createElement('option');
  customOpt.value = '__custom__';
  customOpt.textContent = '✏️ Ввести вручную…';
  select.appendChild(customOpt);
  if (selectedValue) select.value = selectedValue;
  syncModelsDatalist();
}

function renderRoles() {
  const container = $('rolesList');
  container.innerHTML = '';
  for (const role of state.roles) {
    const card = document.createElement('div');
    card.className = `role-card ${role.enabled ? 'enabled' : 'disabled'}`;

    const top = document.createElement('div');
    top.className = 'role-top';

    const label = document.createElement('label');
    label.className = 'role-toggle';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(role.enabled);
    checkbox.addEventListener('change', () => {
      role.enabled = checkbox.checked;
      saveRoles();
      renderRoles();
    });
    const nameSpan = document.createElement('span');
    nameSpan.className = 'role-name';
    nameSpan.textContent = role.name;
    label.appendChild(checkbox);
    label.appendChild(nameSpan);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'role-edit-btn';
    editBtn.title = 'Настроить роль';
    editBtn.textContent = '⚙';
    editBtn.addEventListener('click', () => openRoleModal(role.id));

    top.appendChild(label);
    top.appendChild(editBtn);
    card.appendChild(top);

    const select = document.createElement('select');
    select.className = 'field role-model';
    select.disabled = !role.enabled;
    populateSelectWithModels(select, role.model || state.model);

    const customRow = document.createElement('div');
    customRow.className = 'custom-model-row';
    customRow.hidden = true;
    const customInput = document.createElement('input');
    customInput.type = 'text';
    customInput.className = 'field';
    customInput.placeholder = 'Впиши ID модели…';
    customInput.setAttribute('list', 'modelsDatalist');
    const customApply = document.createElement('button');
    customApply.type = 'button';
    customApply.className = 'button button-primary';
    customApply.textContent = 'ОК';

    const applyRoleCustomModel = () => {
      const value = customInput.value.trim();
      if (!value) {
        select.value = role.model || state.model;
        customRow.hidden = true;
        return;
      }
      role.model = value;
      registerModelOption(value);
      saveRoles();
      renderRoles();
      toast(`Модель для «${role.name}»: ${value}`);
    };
    customApply.addEventListener('click', applyRoleCustomModel);
    customInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyRoleCustomModel();
      }
    });
    customRow.appendChild(customInput);
    customRow.appendChild(customApply);

    select.addEventListener('change', () => {
      if (select.value === '__custom__') {
        customInput.value = role.model || '';
        customRow.hidden = false;
        customInput.focus();
        customInput.select();
        return;
      }
      customRow.hidden = true;
      role.model = select.value;
      saveRoles();
    });
    card.appendChild(select);
    card.appendChild(customRow);

    const meta = document.createElement('div');
    meta.className = 'role-meta';
    meta.textContent = `${describePermissions(role.tools)} · ${role.description}`;
    card.appendChild(meta);

    container.appendChild(card);
  }
  updateTeamBadge();
}

function openRoleModal(roleId = null) {
  state.editingRoleId = roleId;
  const existing = roleId ? state.roles.find((role) => role.id === roleId) : null;
  $('roleModalTitle').textContent = existing ? `Роль: ${existing.name}` : 'Новая роль';
  $('roleNameInput').value = existing ? existing.name : '';
  $('roleModelInput').value = existing ? (existing.model || state.model) : (state.model === 'demo-model' ? 'hydra-gpt-mini' : state.model);
  $('roleDescInput').value = existing ? existing.description : '';
  $('roleInstInput').value = existing ? existing.instructions : '';
  const tools = new Set(existing?.tools ?? ['read', 'write']);
  $('roleToolRead').checked = tools.has('read');
  $('roleToolWrite').checked = tools.has('write');
  $('roleToolBash').checked = tools.has('bash');
  $('deleteRoleButton').hidden = !existing || state.roles.length <= 1;
  syncModelsDatalist();
  $('roleModal').hidden = false;
  $('roleNameInput').focus();
}

async function loadModels() {
  const key = $('apiKey').value.trim();
  if ($('demoMode').checked) {
    saveSettings();
    $('model').value = 'demo-model';
    saveSettings();
    $('connectionStatus').className = 'status ok';
    $('connectionStatus').textContent = 'Демо-режим: можно просто писать задачи';
    toast('Демо-режим включён');
    return;
  }
  if (!key) {
    toast('Сначала вставь ключ HydraAI');
    return;
  }
  saveSettings();
  $('connectionStatus').textContent = 'Проверяю ключ…';
  try {
    const data = await api('/api/models', { headers: { 'x-api-key': key } });
    state.modelOptions = mergeCustomStoredModels(data.models.map((id) => ({ value: id, label: id })));
    localStorage.setItem('harness.models', JSON.stringify(data.models));
    populateSelectWithModels($('model'), state.model);
    renderRoles();
    saveSettings();
    $('connectionStatus').className = 'status ok';
    $('connectionStatus').textContent = `Ключ работает · моделей: ${data.models.length}`;
    toast('Список моделей обновлён');
  } catch (error) {
    $('connectionStatus').className = 'status bad';
    $('connectionStatus').textContent = `Ошибка: ${error.message}`;
    toast(error.message);
  }
}

function applyLeadCustomModel() {
  const value = $('leadCustomModelInput').value.trim();
  if (!value) {
    $('leadCustomModelRow').hidden = true;
    $('model').value = state.model;
    return;
  }
  registerModelOption(value);
  state.model = value;
  populateSelectWithModels($('model'), value);
  $('leadCustomModelRow').hidden = true;
  saveSettings();
}

$('newChat').addEventListener('click', newChat);
$('saveSettings').addEventListener('click', saveSettings);
$('loadModels').addEventListener('click', loadModels);
$('model').addEventListener('change', () => {
  if ($('model').value === '__custom__') {
    $('leadCustomModelInput').value = state.model === 'demo-model' ? '' : state.model;
    $('leadCustomModelRow').hidden = false;
    $('leadCustomModelInput').focus();
    return;
  }
  $('leadCustomModelRow').hidden = true;
  saveSettings();
});
$('leadCustomModelApply').addEventListener('click', applyLeadCustomModel);
$('leadCustomModelInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    applyLeadCustomModel();
  }
});
$('demoMode').addEventListener('change', () => {
  if ($('demoMode').checked) $('model').value = 'demo-model';
  else if ($('model').value === 'demo-model') $('model').value = 'gidra-code-auto';
  saveSettings();
});
$('addRoleButton').addEventListener('click', () => openRoleModal(null));
$('closeRoleModal').addEventListener('click', () => { $('roleModal').hidden = true; });
$('roleModal').addEventListener('click', (event) => {
  if (event.target === $('roleModal')) $('roleModal').hidden = true;
});
$('deleteRoleButton').addEventListener('click', () => {
  if (!state.editingRoleId || state.roles.length <= 1) return;
  state.roles = state.roles.filter((role) => role.id !== state.editingRoleId);
  saveRoles();
  renderRoles();
  $('roleModal').hidden = true;
  toast('Роль удалена');
});
$('roleForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('roleNameInput').value.trim();
  const roleModel = $('roleModelInput').value.trim() || state.model;
  const description = $('roleDescInput').value.trim();
  const instructions = $('roleInstInput').value.trim();
  const tools = [];
  if ($('roleToolRead').checked) tools.push('read', 'list_files', 'search');
  if ($('roleToolWrite').checked) tools.push('write', 'edit', 'delete_file');
  if ($('roleToolBash').checked) tools.push('bash');
  if (!tools.length) tools.push('read', 'list_files', 'search');
  registerModelOption(roleModel);

  if (state.editingRoleId) {
    const role = state.roles.find((item) => item.id === state.editingRoleId);
    if (role) {
      role.name = name;
      role.model = roleModel;
      role.description = description;
      role.instructions = instructions;
      role.tools = tools;
    }
  } else {
    state.roles.push({
      id: `role-${Date.now().toString(36)}`,
      name,
      description,
      instructions,
      model: roleModel,
      enabled: true,
      tools,
    });
  }
  saveRoles();
  renderRoles();
  $('roleModal').hidden = true;
  toast('Роль сохранена');
});
$('sendButton').addEventListener('click', () => sendMessage());
$('stopButton').addEventListener('click', () => state.controller?.abort());
$('composerForm').addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage();
});
$('prompt').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});
$('closeModal').addEventListener('click', () => { $('fileModal').hidden = true; });
$('fileModal').addEventListener('click', (event) => {
  if (event.target === $('fileModal')) $('fileModal').hidden = true;
});
$('rollbackButton').addEventListener('click', async () => {
  if (!state.lastCheckpointId) return;
  if (!confirm('Вернуть файлы и разговор к состоянию до последней задачи?')) return;
  try {
    await api('/api/rollback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, checkpointId: state.lastCheckpointId }),
    });
    toast('Изменения отменены');
    await loadFiles();
    if (state.sessionId) await openSession(state.sessionId);
  } catch (error) {
    toast(error.message);
  }
});
$('messages').addEventListener('click', (event) => {
  const promptBtn = event.target.closest('.prompt-card-btn');
  if (promptBtn) {
    const card = promptBtn.closest('.prompt-card');
    const promptText = card?.querySelector('.prompt-card-text')?.textContent?.trim();
    if (!promptText) return;
    const action = promptBtn.dataset.promptAction;
    if (action === 'use') {
      $('prompt').value = promptText;
      $('prompt').focus();
      toast('Новый запрос вставлен в поле ввода');
    } else if (action === 'sharpen') {
      $('prompt').value = `/sharpen ${promptText}`;
      $('prompt').focus();
      toast('Готово для /sharpen — нажми «Отправить»');
    } else if (action === 'run') {
      if (state.sessionId) {
        newChat();
        toast('Запустил в новом чистом чате, чтобы не тратить лишние токены на прошлый разбор');
      }
      setMode('act');
      $('prompt').value = promptText;
      sendMessage(promptText);
    }
    return;
  }
  const button = event.target.closest('.example');
  if (!button) return;
  $('prompt').value = button.dataset.prompt;
  $('prompt').focus();
});

function updateTokenBadge() {
  const badge = $('tokenBadge');
  const ctx = state.contextTokens.toLocaleString('ru-RU');
  const spent = state.sessionTokens.toLocaleString('ru-RU');
  badge.textContent = state.sessionTokens > 0 ? `📊 ~${ctx} · всего ${spent} ткн` : `📊 ~${ctx} ткн`;
}

function setMode(mode) {
  state.mode = mode === 'plan' ? 'plan' : 'act';
  localStorage.setItem('harness.mode', state.mode);
  const planBtn = $('modePlanBtn');
  const actBtn = $('modeActBtn');
  planBtn.className = state.mode === 'plan' ? 'mode-btn plan-active' : 'mode-btn';
  actBtn.className = state.mode === 'act' ? 'mode-btn active' : 'mode-btn';
  $('modeHint').textContent =
    state.mode === 'plan'
      ? 'Режим «План»: помощник только читает и планирует, файлы не меняются.'
      : 'Режим «Действие»: помощник может менять файлы. Enter — отправить';
}

function saveTemplates() {
  localStorage.setItem('harness.templates', JSON.stringify(state.templates));
}

function renderTemplates() {
  const bar = $('templatesBar');
  bar.innerHTML = '';
  for (const tpl of state.templates) {
    const chip = document.createElement('span');
    chip.className = 'template-chip';
    chip.title = tpl.prompt;

    const btn = document.createElement('span');
    btn.textContent = tpl.label;
    btn.addEventListener('click', () => {
      $('prompt').value = tpl.prompt;
      $('prompt').focus();
    });
    chip.appendChild(btn);

    if (!DEFAULT_TEMPLATES.some((d) => d.id === tpl.id)) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'template-del';
      del.textContent = '×';
      del.title = 'Удалить шаблон';
      del.addEventListener('click', (event) => {
        event.stopPropagation();
        state.templates = state.templates.filter((item) => item.id !== tpl.id);
        saveTemplates();
        renderTemplates();
      });
      chip.appendChild(del);
    }
    bar.appendChild(chip);
  }
}

$('modePlanBtn').addEventListener('click', () => setMode('plan'));
$('modeActBtn').addEventListener('click', () => setMode('act'));
$('saveRulesButton').addEventListener('click', () => {
  state.rules = $('rulesInput').value.trim();
  localStorage.setItem('harness.rules', state.rules);
  toast('Правила проекта сохранены');
});
$('compactButton').addEventListener('click', async () => {
  if (state.busy || !state.sessionId) return;
  if (!state.demo && !state.apiKey.trim()) {
    toast('Для сжатия нужен ключ HydraAI (или включи Демо-режим)');
    return;
  }
  try {
    const data = await api('/api/compact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: state.sessionId,
        apiKey: state.apiKey,
        model: state.model,
        demo: state.demo,
      }),
    });
    if (typeof data.contextTokens === 'number') {
      state.contextTokens = data.contextTokens;
      updateTokenBadge();
    }
    if (!data.compacted) {
      toast(data.message || 'Чат ещё короткий');
    } else {
      addNotice(`Чат сжат вручную: с ~${data.tokensBefore} до ~${data.tokensAfter} токенов.`);
      toast('Чат сжат для экономии токенов');
    }
  } catch (error) {
    toast(error.message);
  }
});
$('addTemplateBtn').addEventListener('click', () => {
  $('templateLabelInput').value = '';
  $('templatePromptInput').value = '';
  $('templateModal').hidden = false;
  $('templateLabelInput').focus();
});
$('closeTemplateModal').addEventListener('click', () => { $('templateModal').hidden = true; });
$('templateModal').addEventListener('click', (event) => {
  if (event.target === $('templateModal')) $('templateModal').hidden = true;
});
$('templateForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const label = $('templateLabelInput').value.trim();
  const prompt = $('templatePromptInput').value.trim();
  if (!label || !prompt) return;
  state.templates.push({ id: `tpl-${Date.now().toString(36)}`, label, prompt });
  saveTemplates();
  renderTemplates();
  $('templateModal').hidden = true;
  toast('Шаблон добавлен');
});

async function loadSkills() {
  try {
    const data = await api('/api/skills');
    state.skills = Array.isArray(data.skills) ? data.skills : [];
    renderSkills();
  } catch {
    const bar = $('skillsBar');
    if (bar) {
      bar.innerHTML =
        '<span class="skills-notice">🔄 Закрой чёрное окно программы и запусти start.bat (start.command) заново, чтобы заработали навыки</span>';
    }
  }
}

function renderSkills() {
  const bar = $('skillsBar');
  if (!bar) return;
  bar.innerHTML = '';
  if (!state.skills.length) {
    bar.innerHTML = '<span class="skills-notice">В папке skills/ пока нет навыков — нажми «＋ Навык»</span>';
    return;
  }
  for (const skill of state.skills) {
    const chip = document.createElement('span');
    chip.className = 'skill-chip';
    chip.title = `${skill.description || skill.title} (режим: ${skill.mode === 'plan' ? 'только план' : 'действие'})`;

    const label = document.createElement('span');
    label.textContent = `${skill.icon} /${skill.name} · ${skill.title}`;
    label.addEventListener('click', () => {
      const current = $('prompt').value.trim().replace(/^\/[a-z0-9-]+\s*/i, '').trim();
      const prefill = current || (skill.name === 'sharpen' && state.lastRefinedPrompt ? state.lastRefinedPrompt : '');
      $('prompt').value = prefill ? `/${skill.name} ${prefill}` : `/${skill.name} `;
      $('prompt').focus();
      if (!prefill) {
        toast(`Напиши свою идею после /${skill.name} и нажми «Отправить»`);
      }
    });
    chip.appendChild(label);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'skill-edit-btn';
    editBtn.textContent = '✎';
    editBtn.title = `Настроить /${skill.name} (skills/${skill.filePath})`;
    editBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      openSkillModal(skill);
    });
    chip.appendChild(editBtn);

    bar.appendChild(chip);
  }
}

function openSkillModal(skill = null) {
  state.editingSkillName = skill?.name ?? null;
  $('skillModalTitle').textContent = skill ? `Навык /${skill.name}` : 'Новый навык (skills/)';
  $('skillNameInput').value = skill?.name ?? '';
  $('skillNameInput').disabled = Boolean(skill);
  $('skillTitleInput').value = skill?.title ?? '';
  $('skillIconInput').value = skill?.icon ?? '🪄';
  $('skillDescInput').value = skill?.description ?? '';
  $('skillModeInput').value = skill?.mode === 'act' ? 'act' : 'plan';
  $('skillInstInput').value = skill?.instructions ?? '';
  $('deleteSkillButton').hidden = !skill;
  $('skillModal').hidden = false;
  (skill ? $('skillTitleInput') : $('skillNameInput')).focus();
}

$('addSkillBtn').addEventListener('click', () => openSkillModal(null));
$('closeSkillModal').addEventListener('click', () => { $('skillModal').hidden = true; });
$('skillModal').addEventListener('click', (event) => {
  if (event.target === $('skillModal')) $('skillModal').hidden = true;
});
$('deleteSkillButton').addEventListener('click', async () => {
  if (!state.editingSkillName) return;
  if (!confirm(`Удалить навык /${state.editingSkillName}?`)) return;
  try {
    const data = await api(`/api/skills?name=${encodeURIComponent(state.editingSkillName)}`, { method: 'DELETE' });
    state.skills = data.skills ?? [];
    renderSkills();
    $('skillModal').hidden = true;
    toast(`Навык /${state.editingSkillName} удалён`);
  } catch (error) {
    toast(error.message);
  }
});
$('skillForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = {
    name: state.editingSkillName || $('skillNameInput').value.trim().toLowerCase(),
    title: $('skillTitleInput').value.trim(),
    icon: $('skillIconInput').value.trim() || '🪄',
    description: $('skillDescInput').value.trim(),
    mode: $('skillModeInput').value === 'act' ? 'act' : 'plan',
    instructions: $('skillInstInput').value.trim(),
  };
  try {
    const data = await api('/api/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    state.skills = data.skills ?? [];
    renderSkills();
    $('skillModal').hidden = true;
    toast(`Навык /${data.skill.name} сохранён в skills/`);
  } catch (error) {
    toast(error.message);
  }
});

let updateBusy = false;
let updateCanRestart = false;

function setUpdateBox(text, tone = '') {
  const box = $('updateStatusBox');
  box.textContent = text;
  box.className = tone ? `update-box ${tone}` : 'update-box';
  box.hidden = !text;
}

async function refreshUpdateModal() {
  setUpdateBox('');
  $('restartAfterUpdateBtn').hidden = true;
  try {
    const data = await api('/api/update/status');
    const savedSource = localStorage.getItem('harness.updateSource');
    $('updateSourceInput').value = savedSource || data.source || '';
    updateCanRestart = Boolean(data.canRestart);

    const sha = data.state?.commitSha || data.git?.sha;
    const shortSha = sha ? sha.slice(0, 7) : 'неизвестно';
    const branch = data.state?.branch || data.git?.branch || 'не определена';
    const when = data.state?.updatedAt
      ? new Date(data.state.updatedAt).toLocaleString('ru-RU')
      : 'обновлений через кнопку ещё не было';
    $('updateCurrentInfo').textContent = `Текущая ветка: ${branch} · коммит: ${shortSha} · ${when}`;

    const backups = Array.isArray(data.backups) ? data.backups : [];
    const rollbackBtn = $('rollbackUpdateBtn');
    if (backups.length) {
      const latest = backups[0];
      const dateStr = latest.createdAt ? new Date(latest.createdAt).toLocaleString('ru-RU') : latest.id;
      rollbackBtn.hidden = false;
      rollbackBtn.title = `Восстановить ${latest.filesCount} файлов от ${dateStr}`;
    } else {
      rollbackBtn.hidden = true;
    }
  } catch (error) {
    $('updateCurrentInfo').textContent = `Не удалось получить данные: ${error.message}`;
  }
}

$('openUpdateBtn').addEventListener('click', () => {
  $('updateModal').hidden = false;
  refreshUpdateModal();
});
$('closeUpdateModal').addEventListener('click', () => {
  if (!updateBusy) $('updateModal').hidden = true;
});
$('updateModal').addEventListener('click', (event) => {
  if (event.target === $('updateModal') && !updateBusy) $('updateModal').hidden = true;
});
$('updateSourceInput').addEventListener('change', () => {
  localStorage.setItem('harness.updateSource', $('updateSourceInput').value.trim());
});

$('checkUpdateBtn').addEventListener('click', async () => {
  if (updateBusy) return;
  const source = $('updateSourceInput').value.trim();
  localStorage.setItem('harness.updateSource', source);
  setUpdateBox('Проверяю свежие коммиты на GitHub…');
  try {
    const data = await api('/api/update/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    const rSha = data.remoteSha ? data.remoteSha.slice(0, 7) : '?';
    const lSha = data.localSha ? data.localSha.slice(0, 7) : 'неизвестен';
    if (data.hasUpdate) {
      setUpdateBox(
        `Доступно обновление на ветке ${data.branch}: ${rSha} (у тебя ${lSha}).\nПоследнее изменение: «${data.remoteMessage}»`,
        'warn',
      );
    } else {
      setUpdateBox(`У тебя уже установлена свежая версия (${rSha} на ветке ${data.branch}).`, 'ok');
    }
  } catch (error) {
    setUpdateBox(`Не удалось проверить: ${error.message}`, 'bad');
  }
});

$('applyUpdateBtn').addEventListener('click', async () => {
  if (updateBusy) return;
  const source = $('updateSourceInput').value.trim();
  localStorage.setItem('harness.updateSource', source);
  updateBusy = true;
  $('applyUpdateBtn').disabled = true;
  $('checkUpdateBtn').disabled = true;
  $('rollbackUpdateBtn').disabled = true;
  $('restartAfterUpdateBtn').hidden = true;
  setUpdateBox('Подключаюсь к GitHub…');

  try {
    const response = await fetch('/api/update/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Ошибка ${response.status}`);
    }
    let result = null;
    await readSse(response, (ev) => {
      if (ev.type === 'progress') {
        setUpdateBox(ev.text);
      } else if (ev.type === 'error') {
        throw new Error(ev.message);
      } else if (ev.type === 'done') {
        result = ev.result;
        updateCanRestart = Boolean(ev.canRestart);
      }
    });
    if (result) {
      const pkgNote = result.packageJsonChanged ? ' (изменился package.json — при запуске проверь зависимости)' : '';
      setUpdateBox(
        `Готово! Обновлено файлов: ${result.filesWritten}. Резервная копия сохранена.${pkgNote}`,
        'ok',
      );
      $('rollbackUpdateBtn').hidden = false;
      $('restartAfterUpdateBtn').hidden = false;
      toast('Обновление установлено!');
    }
  } catch (error) {
    setUpdateBox(`Ошибка обновления: ${error.message}`, 'bad');
    toast(error.message);
  } finally {
    updateBusy = false;
    $('applyUpdateBtn').disabled = false;
    $('checkUpdateBtn').disabled = false;
    $('rollbackUpdateBtn').disabled = false;
  }
});

$('rollbackUpdateBtn').addEventListener('click', async () => {
  if (updateBusy) return;
  if (!confirm('Откатить программу к предыдущей версии из резервной копии?')) return;
  setUpdateBox('Возвращаю файлы предыдущей версии…');
  try {
    const data = await api('/api/update/rollback', { method: 'POST' });
    updateCanRestart = Boolean(data.canRestart);
    setUpdateBox(
      `Откат выполнен: восстановлено файлов — ${data.result.filesRestored}, удалено новых — ${data.result.filesRemoved}.`,
      'ok',
    );
    $('restartAfterUpdateBtn').hidden = false;
    await refreshUpdateModal();
    setUpdateBox(
      `Откат выполнен: восстановлено файлов — ${data.result.filesRestored}, удалено новых — ${data.result.filesRemoved}. Перезапусти программу.`,
      'ok',
    );
    $('restartAfterUpdateBtn').hidden = false;
  } catch (error) {
    setUpdateBox(`Не удалось откатить: ${error.message}`, 'bad');
  }
});

$('restartAfterUpdateBtn').addEventListener('click', async () => {
  setUpdateBox('Перезапускаю программу…');
  try {
    const data = await api('/api/update/restart', { method: 'POST' });
    if (!data.restarting) {
      setUpdateBox(data.message || 'Закрой окно программы и запусти start.bat (start.command) заново.', 'warn');
      return;
    }
    const startedAt = Date.now();
    while (Date.now() - startedAt < 15_000) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await fetch('/api/update/status');
        if (res.ok) {
          window.location.reload();
          return;
        }
      } catch {
        // still restarting
      }
    }
    setUpdateBox('Сервер перезагружается — обнови страницу (F5) через пару секунд.', 'warn');
  } catch (error) {
    setUpdateBox(error.message, 'bad');
  }
});

$('apiKey').value = state.apiKey;
$('demoMode').checked = state.demo;
$('rulesInput').value = state.rules;
setMode(state.mode);
renderTemplates();
updateTokenBadge();
if (state.demo) state.model = 'demo-model';
populateSelectWithModels($('model'), state.model);
$('modelBadge').textContent = state.demo ? 'демо-режим' : state.model;
if (state.demo) {
  $('connectionStatus').className = 'status ok';
  $('connectionStatus').textContent = 'Демо-режим: ключ не нужен';
} else if (state.apiKey) {
  $('connectionStatus').className = 'status ok';
  $('connectionStatus').textContent = 'Ключ сохранён в этом браузере';
}
renderRoles();
loadSkills();
loadFiles();
loadSessions();
