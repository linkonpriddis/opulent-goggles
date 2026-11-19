const assistantList = document.querySelector('#assistant-list');
const assistantCount = document.querySelector('#assistant-count');
const welcome = document.querySelector('#welcome');
const workspace = document.querySelector('#assistant-workspace');
const entryRows = document.querySelector('#entry-rows');
const sheetEmpty = document.querySelector('#sheet-empty');
const entryCount = document.querySelector('#entry-count');
const saveStatus = document.querySelector('#save-status');
const answer = document.querySelector('#answer');

let assistants = [];
let activeAssistant = null;
let entries = [];
let addingRow = false;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'The request could not be completed.');
  return result;
}

function renderAssistants() {
  assistantCount.textContent = assistants.length;
  assistantList.innerHTML = assistants.map((assistant) => `
    <li>
      <button class="assistant-item${assistant.id === activeAssistant?.id ? ' active' : ''}" type="button" data-assistant-id="${assistant.id}" aria-current="${assistant.id === activeAssistant?.id ? 'page' : 'false'}">
        <span class="assistant-symbol" aria-hidden="true">✳</span>
        <span class="assistant-label">${escapeHtml(assistant.name)}</span>
        <span class="assistant-rows">${assistant.entry_count}</span>
      </button>
    </li>`).join('');
}

function dateLabel(value) {
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function renderEntries() {
  entryCount.textContent = entries.length;
  sheetEmpty.hidden = entries.length > 0 || addingRow;
  entryRows.innerHTML = entries.map((entry, index) => `
    <tr data-entry-id="${entry.id}">
      <td class="row-index">${String(index + 1).padStart(2, '0')}</td>
      <td><input class="cell-input" data-field="title" aria-label="Topic" maxlength="160" value="${escapeHtml(entry.title)}"></td>
      <td><textarea class="cell-textarea" data-field="content" aria-label="Collected information" maxlength="100000">${escapeHtml(entry.content)}</textarea></td>
      <td class="date-cell">${escapeHtml(dateLabel(entry.created_at))}</td>
      <td><button class="delete-row" type="button" data-action="delete" aria-label="Delete ${escapeHtml(entry.title)}" title="Delete row">×</button></td>
    </tr>`).join('');

  if (addingRow) {
    entryRows.insertAdjacentHTML('beforeend', `
      <tr class="new-row">
        <td class="row-index">＋</td>
        <td><input class="cell-input" data-new-field="title" aria-label="New topic" maxlength="160" placeholder="Topic"></td>
        <td><textarea class="cell-textarea" data-new-field="content" aria-label="New collected information" maxlength="100000" placeholder="Add information for this assistant"></textarea></td>
        <td class="date-cell">Just now</td>
        <td><button class="delete-row" type="button" data-action="cancel-add" aria-label="Cancel new row" title="Cancel">×</button></td>
      </tr>`);
    entryRows.querySelector('[data-new-field="title"]').focus();
  }
}

function renderWorkspace() {
  const hasAssistant = Boolean(activeAssistant);
  welcome.hidden = hasAssistant;
  workspace.hidden = !hasAssistant;
  if (!hasAssistant) return;
  document.querySelector('#active-name').textContent = activeAssistant.name;
  document.querySelector('#active-description').textContent = activeAssistant.description || 'A private collection of notes and references.';
  answer.innerHTML = '';
  renderAssistants();
  renderEntries();
}

async function loadAssistants(preferredId) {
  assistants = await api('/api/assistants');
  if (preferredId) activeAssistant = assistants.find((assistant) => assistant.id === Number(preferredId)) ?? null;
  else if (activeAssistant) activeAssistant = assistants.find((assistant) => assistant.id === activeAssistant.id) ?? null;
  else activeAssistant = assistants[0] ?? null;
  renderWorkspace();
  if (activeAssistant) await loadEntries();
}

async function loadEntries() {
  if (!activeAssistant) return;
  entries = await api(`/api/assistants/${activeAssistant.id}/entries`);
  renderEntries();
  renderAssistants();
}

function showError(container, message) {
  container.innerHTML = `<p class="answer-error">${escapeHtml(message)}</p>`;
}

document.querySelector('#create-assistant').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.querySelector('#create-error');
  error.textContent = '';
  const formData = new FormData(form);
  try {
    const assistant = await api('/api/assistants', {
      method: 'POST',
      body: JSON.stringify({ name: formData.get('name'), description: formData.get('description') }),
    });
    form.reset();
    await loadAssistants(assistant.id);
  } catch (requestError) {
    error.textContent = requestError.message;
  }
});

assistantList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-assistant-id]');
  if (!button) return;
  activeAssistant = assistants.find((assistant) => assistant.id === Number(button.dataset.assistantId));
  entries = [];
  renderWorkspace();
  try {
    await loadEntries();
  } catch (requestError) {
    showError(answer, requestError.message);
  }
});

document.querySelector('#welcome-create').addEventListener('click', () => {
  document.querySelector('#assistant-name').focus();
  document.querySelector('.create-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

document.querySelector('#add-row').addEventListener('click', () => {
  addingRow = true;
  renderEntries();
});

sheetEmpty.addEventListener('click', (event) => {
  if (!event.target.closest('[data-action="add-first-row"]')) return;
  addingRow = true;
  renderEntries();
});

entryRows.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  if (button.dataset.action === 'cancel-add') {
    addingRow = false;
    renderEntries();
    return;
  }
  if (button.dataset.action !== 'delete') return;
  const row = button.closest('[data-entry-id]');
  if (!row) return;
  try {
    await api(`/api/assistants/${activeAssistant.id}/entries?id=${row.dataset.entryId}`, { method: 'DELETE' });
    await loadEntries();
    saveStatus.textContent = 'Row removed';
  } catch (requestError) {
    saveStatus.textContent = requestError.message;
  }
});

entryRows.addEventListener('keydown', async (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && event.target.matches('[data-new-field="content"]')) {
    event.preventDefault();
    await saveNewRow();
  }
});

async function saveNewRow() {
  const title = entryRows.querySelector('[data-new-field="title"]')?.value.trim();
  const content = entryRows.querySelector('[data-new-field="content"]')?.value.trim();
  if (!title || !content) {
    saveStatus.textContent = 'Add a topic and information';
    return;
  }
  saveStatus.textContent = 'Saving...';
  try {
    await api(`/api/assistants/${activeAssistant.id}/entries`, {
      method: 'POST', body: JSON.stringify({ title, content }),
    });
    addingRow = false;
    await loadEntries();
    saveStatus.textContent = 'Saved to knowledge';
  } catch (requestError) {
    saveStatus.textContent = requestError.message;
  }
}

entryRows.addEventListener('focusout', async (event) => {
  const field = event.target.dataset.field;
  const row = event.target.closest('[data-entry-id]');
  if (!field || !row) return;
  const entry = entries.find((item) => item.id === Number(row.dataset.entryId));
  if (!entry) return;
  const updated = {
    title: row.querySelector('[data-field="title"]').value.trim(),
    content: row.querySelector('[data-field="content"]').value.trim(),
  };
  if (!updated.title || !updated.content) {
    saveStatus.textContent = 'Topic and information cannot be empty';
    return;
  }
  if (updated.title === entry.title && updated.content === entry.content) return;
  saveStatus.textContent = 'Saving...';
  try {
    await api(`/api/assistants/${activeAssistant.id}/entries?id=${entry.id}`, {
      method: 'PATCH', body: JSON.stringify(updated),
    });
    await loadEntries();
    saveStatus.textContent = 'Saved to knowledge';
  } catch (requestError) {
    saveStatus.textContent = requestError.message;
  }
});

document.querySelector('#ask-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const question = new FormData(event.currentTarget).get('question').trim();
  answer.innerHTML = '<div class="answer-box"><p class="answer-summary">Searching saved notes...</p></div>';
  try {
    const result = await api(`/api/assistants/${activeAssistant.id}/ask`, {
      method: 'POST', body: JSON.stringify({ question }),
    });
    answer.innerHTML = `
      <div class="answer-box">
        <p class="answer-label">Search result</p>
        <p class="answer-summary">${escapeHtml(result.answer)}</p>
        ${result.sources.length ? `<div class="source-list">${result.sources.map((source) => `
          <article class="source"><strong>${escapeHtml(source.title)}</strong><p>${escapeHtml(source.excerpt)}</p></article>`).join('')}</div>` : ''}
      </div>`;
  } catch (requestError) {
    showError(answer, requestError.message);
  }
});

loadAssistants().catch((requestError) => showError(answer, requestError.message));