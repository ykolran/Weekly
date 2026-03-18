// ── Color palette ─────────────────────────────────────────────────────────
const COLORS = [
  { bg: '#4a90d9', fg: '#fff' },  // blue
  { bg: '#5cb85c', fg: '#fff' },  // green
  { bg: '#e05c5c', fg: '#fff' },  // red
  { bg: '#f0a030', fg: '#fff' },  // orange
  { bg: '#9b59b6', fg: '#fff' },  // purple
  { bg: '#17a589', fg: '#fff' },  // teal
  { bg: '#e91e8c', fg: '#fff' },  // pink
  { bg: '#607d8b', fg: '#fff' },  // slate
  { bg: '#c8a000', fg: '#fff' },  // amber-dark
  { bg: '#795548', fg: '#fff' },  // brown
];
const DEFAULT_COLOR = COLORS[0];

// ── State ─────────────────────────────────────────────────────────────────
// data shape: { "YYYY-MM-DD": [ { id, text, bg, fg }, ... ] }
let data = {};
let changes = [];
let user = null;  // user info from server
let activeFormInfo = null;  // { formEl }
let dragState = null;       // { actId, fromKey } during a drag operation
let isEditing = false;      // flag to prevent refresh during editing
let weekOffset = 0;        // 0 = default view, positive = weeks ahead, negative = weeks back
let chatWelcomeShown = false;  // track if welcome message was shown

// ── Utility helpers ───────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function toDateKey(d) {
  // Returns "YYYY-MM-DD" in LOCAL time to avoid UTC-shift issues
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function sundayOf(d) {
  const r = new Date(d);
  r.setDate(r.getDate() - r.getDay()); // getDay()==0 for Sun, so this always lands on Sunday
  return r;
}

function isoWeekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

function fmtShortDate(d) {
  return d.toLocaleDateString('he-IL', { month: 'short', day: 'numeric' });
}

function fmtDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── Toast ─────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, duration = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ── Data loading ─────────────────────────────────────────────────────────────
async function loadUser() {
  try {
    const response = await fetch('/api/user');
    if (response.ok) {
      const resp = await response.json();
      user = resp.user;
      console.log('User loaded:', user);
    } else {
      console.error('Failed to load user info');
    }
  } catch (error) {
    console.error('Failed to load user from server', error);
  }
}

async function loadData() {
  try {
    const response = await fetch('/api/activities');
    if (!response.ok) throw new Error(response.statusText);
    const resp = await response.json();
    // resp now holds { activities: {...}, changes: [...] }
    const newDataStr = JSON.stringify(resp.activities);
    const oldDataStr = JSON.stringify(data);
    if (newDataStr !== oldDataStr || oldDataStr === '{}') {
      data = resp.activities;
      renderCalendar();
    }
    // always update changes (server returns newest first)
    changes = resp.changes || [];
    renderChangeLog();
    document.getElementById('statusText').textContent = 'Connected to server';
    
  } catch (error) {
    console.error('Failed to load data from server', error);
    document.getElementById('statusText').textContent = error;
  }
}

// ── Change log rendering ─────────────────────────────────────────────────
function renderChangeLog() {
  const container = document.getElementById('changeLog');
  if (!container) return;
  container.innerHTML = '';
  // header
  const title = document.createElement('div');
  title.className = 'log-title';
  title.textContent = 'עדכונים אחרונים';
  container.appendChild(title);

  // group by date, but only last 2 weeks
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);
  const groups = {};
  changes.forEach(c => {
    const dStr = c.date || c.time.slice(0,10);
    const d = new Date(dStr);
    if (d < cutoff) return;
    if (!groups[dStr]) groups[dStr] = [];
    groups[dStr].push(c.desc);
  });
  // iterate in order of changes array to preserve desc order within day
  const seen = new Set();
  changes.forEach(c => {
    const dStr = c.date || c.time.slice(0,10);
    const d = new Date(dStr);
    if (d < cutoff) return;
    if (seen.has(dStr)) return;
    seen.add(dStr);
    const header = document.createElement('div');
    header.className = 'entry';
    header.style.fontWeight = '700';
    header.textContent = d.toLocaleDateString('he-IL');
    container.appendChild(header);
    groups[dStr].forEach(desc => {
      const item = document.createElement('div');
      item.className = 'entry';
      item.textContent = desc;
      container.appendChild(item);
    });
  });
}

// ── Week navigation ──────────────────────────────────────────────────────
function prevWeek() {
  weekOffset -= 1;
  renderCalendar();
}

function nextWeek() {
  weekOffset += 1;
  renderCalendar();
}

// ── Calendar rendering ────────────────────────────────────────────────────
function renderCalendar() {
  const tbody = document.getElementById('calBody');
  tbody.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = toDateKey(today);
  // start from Sunday of prev week, shifted by weekOffset (weeks)
  const startSunday = addDays(sundayOf(today), -7 + (weekOffset * 7));

  const WEEKS = 6; // previous week + current week + 4 ahead

  for (let w = 0; w < WEEKS; w++) {
    const weekStart = addDays(startSunday, w * 7);
    const isPastRow = w === 0;

    const tr = document.createElement('tr');
    if (isPastRow) tr.classList.add('past-week');

    // Week number label — use Monday of this week for ISO week number
    const wkTd = document.createElement('td');
    wkTd.className = 'wk-label';
    wkTd.textContent = 'ש' + isoWeekNumber(addDays(weekStart, 1));
    tr.appendChild(wkTd);

    for (let d = 0; d < 7; d++) {
      const day = addDays(weekStart, d);
      const key = toDateKey(day);
      const isToday = key === todayKey;
      const isPast = key < todayKey;
      const isWeekend = d === 5 || d === 6; // Fri or Sat

      const td = document.createElement('td');
      td.className = 'day-cell';
      if (isToday) td.classList.add('is-today');
      if (isPast) td.classList.add('is-past');
      if (isWeekend) td.classList.add('is-weekend');
      td.dataset.key = key;

      // Drop target for drag-and-drop
      td.addEventListener('dragover', e => {
        if (!dragState) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        td.classList.add('drag-over');
      });
      td.addEventListener('dragleave', e => {
        if (!td.contains(e.relatedTarget)) td.classList.remove('drag-over');
      });
      td.addEventListener('drop', e => {
        e.preventDefault();
        td.classList.remove('drag-over');
        if (!dragState) return;
        const actId = dragState.actId;
        moveActivity(dragState.fromKey, actId, key);
        dragState = null;
      });

      // Day header
      const headerDiv = document.createElement('div');
      headerDiv.className = 'day-header';
      const dateSpan = document.createElement('div');
      dateSpan.className = 'day-date';
      dateSpan.textContent = fmtShortDate(day);
      const numSpan = document.createElement('div');
      numSpan.className = isToday ? 'day-num today-num' : 'day-num';
      numSpan.textContent = day.getDate();
      headerDiv.appendChild(dateSpan);
      headerDiv.appendChild(numSpan);
      td.appendChild(headerDiv);

      // Activities container
      const actsDiv = document.createElement('div');
      actsDiv.className = 'activities';
      actsDiv.id = 'acts-' + key;
      renderActivitiesInto(actsDiv, key);
      td.appendChild(actsDiv);

      // Add button
      const addBtn = document.createElement('div');
      addBtn.className = 'add-btn';
      addBtn.textContent = '+ הוסף';
      addBtn.addEventListener('click', e => {
        e.stopPropagation();
        openForm(td, key, null);
      });
      td.appendChild(addBtn);

      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }
}

function getActivitiesForDay(key) {
  return data[key] || [];
}

function renderActivitiesInto(container, key) {
  container.innerHTML = '';
  const acts = getActivitiesForDay(key);
  acts.forEach(act => {
    const div = document.createElement('div');
    div.className = 'activity-item';
    div.style.background = act.bg;
    div.style.color = act.fg;
    div.draggable = true;

    const textSpan = document.createElement('span');
    textSpan.className = 'act-text';
    textSpan.textContent = act.text;

    const actions = document.createElement('span');
    actions.className = 'act-actions';

    const editIcon = document.createElement('span');
    editIcon.className = 'act-icon';
    editIcon.title = 'ערוך';
    editIcon.textContent = '✎';
    editIcon.addEventListener('click', e => {
      e.stopPropagation();
      const cell = div.closest('td');
      openForm(cell, key, act);
    });

    const delIcon = document.createElement('span');
    delIcon.className = 'act-icon';
    delIcon.title = 'מחק';
    delIcon.textContent = '✕';
    delIcon.addEventListener('click', e => {
      e.stopPropagation();
      deleteActivity(key, act.id);
    });

    // Drag events for moving
    div.addEventListener('dragstart', e => {
      dragState = { actId: act.id, fromKey: key };
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => div.classList.add('dragging'), 0);
    });
    div.addEventListener('dragend', () => {
      div.classList.remove('dragging');
      dragState = null;
    });

    actions.appendChild(editIcon);
    actions.appendChild(delIcon);
    div.appendChild(textSpan);
    div.appendChild(actions);
    container.appendChild(div);
  });
}

function refreshActivitiesUI(key) {
  const container = document.getElementById('acts-' + key);
  if (container) renderActivitiesInto(container, key);
}

// ── Activity form (add / edit) ────────────────────────────────────────────
function closeForm() {
  if (activeFormInfo) {
    activeFormInfo.formEl.remove();
    activeFormInfo = null;
  }
  isEditing = false;
}

function openForm(cell, key, existing) {
  closeForm();

  let chosenColor = existing
    ? (COLORS.find(c => c.bg === existing.bg) || DEFAULT_COLOR)
    : DEFAULT_COLOR;

  const form = document.createElement('div');
  form.className = 'act-form';
  form.addEventListener('click', e => e.stopPropagation());

  const inp = document.createElement('input');
  inp.type = 'text';
  inp.placeholder = 'תאר את הפעילות...';
  inp.maxLength = 300;
  if (existing) inp.value = existing.text;
  form.appendChild(inp);

  const swatchRow = document.createElement('div');
  swatchRow.className = 'swatches';
  COLORS.forEach(c => {
    const s = document.createElement('div');
    s.className = 'swatch' + (c.bg === chosenColor.bg ? ' sel' : '');
    s.style.background = c.bg;
    s.addEventListener('click', () => {
      swatchRow.querySelectorAll('.swatch').forEach(x => x.classList.remove('sel'));
      s.classList.add('sel');
      chosenColor = c;
    });
    swatchRow.appendChild(s);
  });
  form.appendChild(swatchRow);

  const row = document.createElement('div');
  row.className = 'form-row';

  const okBtn = document.createElement('button');
  okBtn.className = 'fbtn fbtn-ok';
  okBtn.textContent = existing ? 'עדכן' : 'הוסף';
  okBtn.addEventListener('click', () => {
    const text = inp.value.trim();
    if (!text) { inp.focus(); return; }
    if (existing) {
      updateActivity(key, existing.id, text, chosenColor);
    } else {
      addActivity(key, text, chosenColor);
    }
    closeForm();
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'fbtn fbtn-cancel';
  cancelBtn.textContent = 'ביטול';
  cancelBtn.addEventListener('click', closeForm);

  row.appendChild(okBtn);
  row.appendChild(cancelBtn);
  form.appendChild(row);

  cell.querySelector('.activities').after(form);
  activeFormInfo = { formEl: form };

  inp.focus();
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') okBtn.click();
    if (e.key === 'Escape') closeForm();
  });

  isEditing = true;
}

// ── Activity CRUD ─────────────────────────────────────────────────────────
async function addActivity(key, text, color) {
  try {
    const response = await fetch('/api/activities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: key, text, bg: color.bg, fg: color.fg })
    });
    const result = await response.json();
    // refresh full data to pick up changes
    await loadData();
  } catch (error) {
    showToast('Failed to add activity');
    console.error(error);
  }
}

async function updateActivity(key, id, text, color) {
  try {
    await fetch(`/api/activities/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, bg: color.bg, fg: color.fg })
    });
    await loadData();
  } catch (error) {
    showToast('Failed to update activity');
    console.error(error);
  }
}

async function deleteActivity(key, id) {
  try {
    await fetch(`/api/activities/${id}`, { method: 'DELETE' });
    await loadData();
  } catch (error) {
    showToast('Failed to delete activity');
    console.error(error);
  }
}

async function moveActivity(fromKey, actId, toKey) {
  try {
    await fetch(`/api/activities/${actId}/move`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: toKey })
    });
    await loadData();
  } catch (error) {
    showToast('Failed to move activity');
    console.error(error);
  }
}

// ── Chat functionality ────────────────────────────────────────────────────
function addChatMessage(text, isUser) {
  const messagesDiv = document.getElementById('chatMessages');
  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-message ${isUser ? 'user' : 'bot'}`;

  let content;
  if (isUser) {
    // user messages should remain plain text
    content = escapeHtml(text);
  } else {
    // render markdown from the server
    content = DOMPurify.sanitize(marked.parse(text));
  }

  msgDiv.innerHTML = `<div class="msg">${content}</div>`;
  messagesDiv.appendChild(msgDiv);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const message = input.value.trim();
  if (!message) return;
  
  // Add user message to chat
  addChatMessage(message, true);
  input.value = '';
  
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: message })
    });
    
    const result = await response.json();
    addChatMessage(result.answer, false);
  } catch (error) {
    addChatMessage('סליחה, לא יכלתי לעבד את השאלה. נסה שוב.', false);
    addChatMessage(error, false);
    console.error('Chat error:', error);
  }
}

// ── App init ──────────────────────────────────────────────────────────────
async function init() {
  await loadUser();
  await loadData();

  document.addEventListener('click', () => closeForm());

   // Poll for updates every 5 seconds, but skip if user is editing
  setInterval(async () => {
    if (!isEditing) {
      await loadData();
    }
  }, 5000);
  // wire week nav buttons
  const prevBtn = document.getElementById('prevWeek');
  const nextBtn = document.getElementById('nextWeek');
  if (prevBtn) prevBtn.addEventListener('click', () => { prevWeek(); });
  if (nextBtn) nextBtn.addEventListener('click', () => { nextWeek(); });

  // keyboard arrows
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') prevWeek();
    if (e.key === 'ArrowRight') nextWeek();
  });

  // wheel + Ctrl to navigate weeks (prevents accidental scroll)
  const calWrap = document.querySelector('.cal-wrap');
  if (calWrap) {
    calWrap.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (e.deltaY > 0) nextWeek(); else prevWeek();
    }, { passive: false });
  }

  // Chat event listeners
  const chatSendBtn = document.getElementById('chatSend');
  const chatInput = document.getElementById('chatInput');
  const chatContainer = document.querySelector('.chat-container');

  if (chatSendBtn) {
    chatSendBtn.addEventListener('click', sendChatMessage);
  }
  
  if (chatInput) {
    chatInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendChatMessage();
    });
  }

  // Show welcome message on init since chat is always open
  if (!chatWelcomeShown && user) {
    const userName = user.name || 'משתמש';
    addChatMessage(`שלום ${userName}! אני כאן לעזור לך עם התכנון השבועי שלך.`, false);
    chatWelcomeShown = true;
  }
}

init();
