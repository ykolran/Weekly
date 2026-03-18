const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const fss = require('fs');  // sync version for atomic rename
const path = require('path');
const axios = require('axios');
const NodeSSPI = require('node-sspi');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'activities.json');
const BACKUP_DIR = path.join(__dirname, 'backups');
const MAX_BACKUPS = 20;  // keep last 20 backups

// Control whether to perform real Windows authentication.  Set USE_SSPI=false
// in your environment when running locally or during development to bypass the
// NTLM/Negotiate handshake and fall back to the simple environment-based user
// that the previous version of this app used.
const USE_SSPI = process.env.USE_SSPI !== 'false';


// Authentication is performed with node-sspi (Windows Integrated
// Authentication).  A simple environment-based fallback is available for
// scenarios where SSPI is undesirable (e.g. local development).


// Ensure backup directory exists (synchronously for startup)
function ensureBackupDirSync() {
  try {
    if (!fss.existsSync(BACKUP_DIR)) {
      fss.mkdirSync(BACKUP_DIR, { recursive: true });
      console.log('Created backup directory:', BACKUP_DIR);
    }
  } catch (error) {
    console.error('Failed to create backup directory:', error);
  }
}

// Validate JSON structure
function validateData(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (!('activities' in obj) || !('changes' in obj)) return false;
  if (typeof obj.activities !== 'object' || !Array.isArray(obj.changes)) return false;
  return true;
}

// Create timestamped backup
async function createBackup() {
  try {
    // Ensure backup directory exists
    ensureBackupDirSync();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const backupFile = path.join(BACKUP_DIR, `activities-${timestamp}.json`);
    const currentData = await fs.readFile(DATA_FILE, 'utf8');
    await fs.writeFile(backupFile, currentData);
    console.log('Backup created:', backupFile);

    // Clean up old backups (keep only MAX_BACKUPS)
    const files = await fs.readdir(BACKUP_DIR);
    const backupFiles = files
      .filter(f => f.startsWith('activities-') && f.endsWith('.json'))
      .sort()
      .reverse();

    for (let i = MAX_BACKUPS; i < backupFiles.length; i++) {
      await fs.unlink(path.join(BACKUP_DIR, backupFiles[i]));
      console.log('Deleted old backup:', backupFiles[i]);
    }
  } catch (error) {
    console.error('Backup creation failed:', error);
  }
}

// Atomic write with backup
async function writeData(data) {
  if (!validateData(data)) {
    throw new Error('Invalid data structure');
  }

  try {
    // Ensure backup directory exists
    ensureBackupDirSync();

    // Create backup before writing
    if (fss.existsSync(DATA_FILE)) {
      await createBackup();
    }

    const tempFile = DATA_FILE + '.tmp';
    const jsonStr = JSON.stringify(data, null, 2);

    // Write to temporary file
    await fs.writeFile(tempFile, jsonStr, 'utf8');

    // Atomic rename (overwrites atomically on both Linux and Windows)
    fss.renameSync(tempFile, DATA_FILE);
  } catch (error) {
    console.error('Write failed:', error);
    throw error;
  }
}

// Middleware
app.use(cors());
app.use(session({
  secret: 'weekly-planner-secret-key', // Change this to a secure secret in production
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // Set to true if using HTTPS
}));
// we still keep express-session for any other stateful needs, but authentication
// does not rely on an external auth library.
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Authentication middleware using node-sspi.  It attaches the Windows user
// name to `req.user` and falls back to environment variables if SSPI doesn't
// provide a user (e.g. running locally or on non-Windows platforms).
function requireAuth(req, res, next) {
  // if SSPI is disabled we simply use the environment-based fallback user and
  // never trigger the NTLM challenge.  This mirrors the behavior of the old
  // previous version always returned the environment user regardless of SSPI.
  if (!USE_SSPI) {
    const userName = process.env.USERNAME || process.env.USER || 'Unknown User';
    const domain = process.env.USERDOMAIN || 'LOCAL';
    console.log('Using fallback authentication (SSPI disabled) with user:', { name: userName, domain });
    req.user = { name: userName, domain };
    return next();
  }

  const nodeSSPI = new NodeSSPI({ retrieveGroups: true });
  nodeSSPI.authenticate(req, res, (err) => {
    if (err) {
      console.error('Auth error:', err);
      if (!res.finished) {
        return res.status(500).json({ error: 'Authentication error' });
      }
      return; // response already sent
    }

    if (res.finished) {
      // node-sspi already replied (e.g. with 401/redirect); do not continue
      return;
    }

    // node-sspi sets the Windows account on req.connection.user.  It usually
    // comes in the form "DOMAIN\\username".
    let rawUser = req.connection && req.connection.user;
    let user;

    if (rawUser) {
      if (rawUser.includes('\\')) {
        const [domain, name] = rawUser.split('\\');
        let inGroup = req.connection.userGroups.includes('BUILTIN\\Administrators');
        user = { name, domain, inGroup };
      } else {
        user = { name: rawUser, inGroup: false };
      }
    } else {
      // fallback to environment if SSPI unexpectedly produced no user (this
      // path is rarely reached when USE_SSPI=true).
      const userName = process.env.USERNAME || process.env.USER || 'Unknown User';
      const domain = process.env.USERDOMAIN || 'LOCAL';
      console.log('Using fallback authentication with user:', { name: userName, domain });
      user = { name: userName, domain, inGroup: false };
    }

    req.user = user;
    next();
  });
}


// Helper to read data
async function readData() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    const obj = JSON.parse(data);

    // Validate structure
    if (!validateData(obj)) {
      throw new Error('Invalid data structure');
    }

    // Ensure structure
    if (!obj.activities) obj.activities = {};
    if (!obj.changes) obj.changes = [];
    return obj;
  } catch (error) {
    console.error('Error reading main data file:', error.message);

    // Try to recover from most recent backup
    try {
      const files = await fs.readdir(BACKUP_DIR);
      const backupFiles = files
        .filter(f => f.startsWith('activities-') && f.endsWith('.json'))
        .sort()
        .reverse();

      if (backupFiles.length > 0) {
        const latestBackup = backupFiles[0];
        console.log(`Recovering from backup: ${latestBackup}`);
        const backupData = await fs.readFile(path.join(BACKUP_DIR, latestBackup), 'utf8');
        return JSON.parse(backupData);
      }
    } catch (backupError) {
      console.error('Failed to recover from backup:', backupError.message);
    }

    // Return empty structure as last resort
    console.log('Returning empty data structure');
    return { activities: {}, changes: [] };
  }
}

async function addActivityLLM(date, text, bg, fg) {
  const data = await readData();

  if (!data.activities[date]) data.activities[date] = [];

  const id = Date.now().toString(36);

  // reuse your normalization logic
  const { bg: finalBg, fg: finalFg } = normalizeColorOrDefault(bg, fg);

  data.activities[date].push({
    id,
    text,
    bg: finalBg,
    fg: finalFg
  });

  data.changes.unshift({
    date: new Date().toISOString().slice(0, 10),
    desc: `הפעילות \"${text}\" נוספה דרך הצ'אט`
  });

  await writeData(data);
}


async function moveActivityByTextAndDate(text, fromDate, toDate) {
  const data = await readData();
  const acts = data.activities[fromDate] || [];
  const idx = acts.findIndex(a => a.text === text);
  if (idx === -1) return false;
  const [act] = acts.splice(idx, 1);
  if (acts.length === 0) delete data.activities[fromDate];
  if (!data.activities[toDate]) data.activities[toDate] = [];
  data.activities[toDate].push(act);
  data.changes.unshift({
    date: new Date().toISOString().slice(0, 10),
    desc: `הפעילות "${act.text}" הועברה מ-${fromDate} ל-${toDate}`
  });
  await writeData(data);
  return true;
}

async function deleteActivityByTextAndDate(text, date) {
  const data = await readData();
  const acts = data.activities[date] || [];
  const idx = acts.findIndex(a => a.text === text);
  if (idx === -1) return false;
  const [removed] = acts.splice(idx, 1);
  if (acts.length === 0) delete data.activities[date];
  data.changes.unshift({
    date: new Date().toISOString().slice(0, 10),
    desc: `הפעילות "${removed.text}" נמחקה מ-${date}`
  });
  await writeData(data);
  return true;
}

function normalizeColorOrDefault(bg, fg) {
  // very simple validation, you can tighten it
  const defaultBg = "#4a90d9";
  const defaultFg = "#ffffff";

  const hexRe = /^#?[0-9a-fA-F]{6}$/;

  let bgOut = bg && hexRe.test(bg) ? bg : defaultBg;
  let fgOut = fg && hexRe.test(fg) ? fg : defaultFg;

  if (!bgOut.startsWith('#')) bgOut = '#' + bgOut.replace('#', '');
  if (!fgOut.startsWith('#')) fgOut = '#' + fgOut.replace('#', '');

  return { bg: bgOut, fg: fgOut };
}

async function bulkColorByTextContains(query, bg, fg) {
  const data = await readData();
  const { bg: newBg, fg: newFg } = normalizeColorOrDefault(bg, fg);
  let count = 0;

  for (const [date, acts] of Object.entries(data.activities)) {
    for (const act of acts) {
      if (act.text && act.text.includes(query)) {
        act.bg = newBg;
        act.fg = newFg;
        count++;
      }
    }
  }

  if (count > 0) {
    data.changes.unshift({
      date: new Date().toISOString().slice(0, 10),
      desc: `שונו הצבעים של ${count} פעילויות המכילות את \"${query}\"`
    });
    await writeData(data);
  }

  return count;
}

async function bulkColorByDateRange(fromDate, toDate, bg, fg) {
  const data = await readData();
  const { bg: newBg, fg: newFg } = normalizeColorOrDefault(bg, fg);
  let count = 0;

  const from = new Date(fromDate);
  const to = new Date(toDate);

  for (const [date, acts] of Object.entries(data.activities)) {
    const d = new Date(date);
    if (d >= from && d <= to) {
      for (const act of acts) {
        act.bg = newBg;
        act.fg = newFg;
        count++;
      }
    }
  }

  if (count > 0) {
    data.changes.unshift({
      date: new Date().toISOString().slice(0, 10),
      desc: `שונו הצבעים של ${count} פעילויות בין ${fromDate} ל-${toDate}`
    });
    await writeData(data);
  }

  return count;
}

async function bulkAddActivities(dates, text, bg, fg) {
  const data = await readData();
  const { bg: newBg, fg: newFg } = normalizeColorOrDefault(bg, fg);
  let count = 0;

  for (const date of dates) {
    if (!isValidDateString(date)) continue;
    if (!data.activities[date]) data.activities[date] = [];
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    data.activities[date].push({ id, text, bg: newBg, fg: newFg });
    count++;
  }

  if (count > 0) {
    data.changes.unshift({
      date: new Date().toISOString().slice(0, 10),
      desc: `נוספו ${count} פעילויות \"${text}\" בתאריכים מרובים דרך הצ'אט`
    });
    await writeData(data);
  }

  return count;
}

// Routes
app.get('/api/user', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/activities', requireAuth, async (req, res) => {
  if (!req.user.inGroup)
    return res.status(401).json({ error: 'User' && res.user && ' not in group.' });
  try {
    const data = await readData();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


app.post('/api/activities', requireAuth, async (req, res) => {
  const { date, text, bg, fg } = req.body;
  if (!req.user.inGroup)
    return res.status(401).json({ error: 'User' && res.user && ' not in group.' });
  if (!date || !text || !bg || !fg) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  try {
    const data = await readData();
    if (!data.activities[date]) data.activities[date] = [];
    data.activities[date].push({ id, text, bg, fg });
    // log change (date only)
    data.changes.unshift({
      date: new Date().toISOString().slice(0, 10),
      desc: `הפעילות "${text}" נוספה`
    });
    await writeData(data);
    res.json({ id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/activities/:id', requireAuth, async (req, res) => {
  if (!req.user.inGroup)
    return res.status(401).json({ error: 'User' && res.user && ' not in group.' });
  const { id } = req.params;
  const { text, bg, fg } = req.body;
  if (!text || !bg || !fg) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const data = await readData();
    let found = false;
    for (const date in data.activities) {
      const acts = data.activities[date];
      const act = acts.find(a => a.id === id);
      if (act) {
        const prevText = act.text;
        const textChanged = prevText !== text;
        act.text = text;
        act.bg = bg;
        act.fg = fg;
        found = true;
        // log only if text changed
        if (textChanged) {
          data.changes.unshift({
            date: new Date().toISOString().slice(0, 10),
            desc: `פעילות "${prevText}" שונתה ל-"${text}"`
          });
        }
        break;
      }
    }
    if (!found) return res.status(404).json({ error: 'Activity not found' });
    await writeData(data);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/activities/:id/move', requireAuth, async (req, res) => {
  if (!req.user.inGroup)
    return res.status(401).json({ error: 'User' && res.user && ' not in group.' });
  const { id } = req.params;
  const { date } = req.body;
  if (!date) {
    return res.status(400).json({ error: 'Missing date' });
  }
  try {
    const data = await readData();
    let act;
    let oldDate;
    for (const d in data.activities) {
      const acts = data.activities[d];
      const idx = acts.findIndex(a => a.id === id);
      if (idx !== -1) {
        act = acts.splice(idx, 1)[0];
        oldDate = d;
        if (acts.length === 0) delete data.activities[d];
        break;
      }
    }
    if (!act) return res.status(404).json({ error: 'Activity not found' });
    if (!data.activities[date]) data.activities[date] = [];
    data.activities[date].push(act);
    // log change
    data.changes.unshift({
      date: new Date().toISOString().slice(0, 10),
      desc: `הפעילות "${act.text}" הועברה מ-${oldDate} ל-${date}`
    });
    await writeData(data);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/activities/:id', requireAuth, async (req, res) => {
  if (!req.user.inGroup)
    return res.status(401).json({ error: 'User' && res.user && ' not in group.' });
  const { id } = req.params;
  try {
    const data = await readData();
    let found = false;
    for (const date in data.activities) {
      const acts = data.activities[date];
      const idx = acts.findIndex(a => a.id === id);
      if (idx !== -1) {
        const [removed] = acts.splice(idx, 1);
        if (acts.length === 0) delete data.activities[date];
        found = true;
        // log deletion
        data.changes.unshift({
          date: new Date().toISOString().slice(0, 10),
          desc: `הפעילות "${removed.text}" נמחקה מ-${date}`
        });
        break;
      }
    }
    if (!found) return res.status(404).json({ error: 'Activity not found' });
    await writeData(data);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Backup and recovery endpoints
app.get('/api/backups', requireAuth, async (req, res) => {
  if (!req.user.inGroup)
    return res.status(401).json({ error: 'User' && res.user && ' not in group.' });
  try {
    const files = await fs.readdir(BACKUP_DIR);
    const backups = files
      .filter(f => f.startsWith('activities-') && f.endsWith('.json'))
      .map(f => ({
        timestamp: f.replace('activities-', '').replace('.json', ''),
        filename: f
      }))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    res.json(backups);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/backups/restore/:timestamp', requireAuth, async (req, res) => {
  if (!req.user.inGroup)
    return res.status(401).json({ error: 'User' && res.user && ' not in group.' });
  try {
    const { timestamp } = req.params;
    const backupFile = path.join(BACKUP_DIR, `activities-${timestamp}.json`);

    // Verify backup exists
    const stat = await fs.stat(backupFile);
    if (!stat.isFile()) {
      return res.status(404).json({ error: 'Backup not found' });
    }

    // Read and validate backup
    const backupContent = await fs.readFile(backupFile, 'utf8');
    const backupData = JSON.parse(backupContent);

    if (!validateData(backupData)) {
      return res.status(400).json({ error: 'Backup data is corrupted' });
    }

    // Create backup of current state before restoring
    if (fss.existsSync(DATA_FILE)) {
      await createBackup();
    }

    // Restore the backup
    await writeData(backupData);

    res.json({
      success: true,
      message: `Data restored from ${timestamp}`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Chat endpoint - process questions about activities using LLM
app.post('/api/chat', requireAuth, async (req, res) => {
  if (!req.user.inGroup)
    return res.status(401).json({ error: 'User' && res.user && ' not in group.' });
  try {
    const { question } = req.body;
    if (!question) {
      return res.status(400).json({ error: 'Missing question' });
    }

    const data = await readData();
    const answer = await generateChatResponse(question, data, req.user);
    res.json({ answer });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Failed to process question' });
  }
});

function safeParseLLMJson(text) {
  if (!text) return null;

  // handle special openai/gpt-oss-20b wrapper
  text = extractOssJsonPayload(text);

  let trimmed = text.trim();

  // Strip ```json ... ``` or ``` ... ```
  if (trimmed.startsWith('```')) {
    const firstNewline = trimmed.indexOf('\n');
    if (firstNewline !== -1) {
      trimmed = trimmed.slice(firstNewline + 1);
      const lastFence = trimmed.lastIndexOf('```');
      if (lastFence !== -1) trimmed = trimmed.slice(0, lastFence);
    }
    trimmed = trimmed.trim();
  }

  // 1) Try single JSON object/array directly
  try {
    const parsed = JSON.parse(trimmed);
    return parsed;
  } catch {
    // fall through
  }

  // 2) Try to parse as concatenated JSON objects: {...}{...}{...}
  const objs = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      if (depth === 0 && start === -1) start = i === 0 ? 0 : i - 0;
      continue;
    }

    if (ch === '{' || ch === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0 && start !== -1) {
        const chunk = trimmed.slice(start, i + 1);
        try {
          const parsed = JSON.parse(chunk);
          objs.push(parsed);
        } catch {
          // ignore this chunk
        }
        start = -1;
      }
    }
  }

  if (objs.length === 1) return objs[0];
  if (objs.length > 1) return objs;

  // nothing worked
  return null;
}


function isValidDateString(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(date);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function buildActivitiesSummary(activities, today, windowDays = 60) {
  const todayDate = new Date(today);
  const entries = [];

  for (const [date, acts] of Object.entries(activities)) {
    const d = new Date(date);
    const diffDays = Math.abs((d - todayDate) / (1000 * 60 * 60 * 24));
    if (diffDays <= windowDays) {
      entries.push(`${date}: ${acts.map(a => a.text).join(', ')}`);
    }
  }

  if (entries.length === 0) return '';
  entries.sort(); // chronological
  return entries.join('\n');
}

function extractOssJsonPayload(raw) {
  if (!raw) return raw;
  let text = raw.trim();

  // Find the OSS wrapper marker
  const marker = '<|message|>';
  const idx = text.indexOf(marker);
  if (idx !== -1) {
    text = text.slice(idx + marker.length).trim();
  }

  // At this point text is something like: {\"action\":\"add\",...}
  // It may itself be JSON-encoded as a string (outer quotes)
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    try {
      text = JSON.parse(text); // unescape \" → "
    } catch {
      // ignore, fall through with original text
    }
  }

  return text.trim();
}


// Helper function to generate chat responses using Ollama LLM
async function generateChatResponse(question, data, user) {
  try {
    // Prepare context about activities   
    const today = new Date().toISOString().slice(0, 10);
    const activitiesSummary = buildActivitiesSummary(data.activities, today, 60);
    const userName = user && user.name ? user.name : 'משתמש';

    const systemPrompt = `
You are an assistant for a weekly planner.

There are two modes:

1) COMMAND MODE – when the user clearly asks to add, move, delete or change colors of activities.
In this case you MUST respond with a single or multiple JSON objects and NOTHING else.
Valid shapes:

For ADD:
{
  "action": "add",
  "date": "YYYY-MM-DD",
  "text": "activity description",
  "bg": "#RRGGBB",        // optional, default blue
  "fg": "#RRGGBB"         // optional, default white
}

For MOVE:
{
  "action": "move",
  "text": "existing activity description",
  "fromDate": "YYYY-MM-DD",
  "toDate": "YYYY-MM-DD"
}

For DELETE:
{
  "action": "delete",
  "text": "existing activity description",
  "date": "YYYY-MM-DD"
}

For BULK COLOR CHANGE by substring:
{
  "action": "bulkColor",
  "scope": "textContains",
  "query": "substring to search in text",
  "bg": "#RRGGBB",
  "fg": "#RRGGBB"         // optional
}

For BULK COLOR CHANGE by date:
{
  "action": "bulkColor",
  "scope": "dateRange",
  "fromDate": "YYYY-MM-DD",
  "toDate": "YYYY-MM-DD",
  "bg": "#RRGGBB",
  "fg": "#RRGGBB"         // optional
}

For BULK ADD (e.g. every day next week):
{
  "action": "bulkAdd",
  "dates": ["YYYY-MM-DD", "YYYY-MM-DD", "..."],
  "text": "activity description",
  "bg": "#RRGGBB",        // optional
  "fg": "#RRGGBB"         // optional
}

Rules:
- Never add explanation, code fences or extra text.
- Do not invent dates; if the user did not specify a date, infer it only if it’s unambiguous
  (e.g., "היום", "מחר", "שבוע הבא") and convert to explicit dates list either in BULK ADD or in multiple JSON objects.
- Use exact text of the existing activity when moving/deleting if possible.

2) CHAT MODE – for all other questions.
In this case answer naturally in Hebrew, without JSON.

Current activities:
${activitiesSummary || '(אין פעילויות קיימות)'}

Today: ${today}
User: ${userName}
`;

    // Call Ollama API
    const response = await axios.post(
      'http://localhost:1234/v1/chat/completions',
      {
        model: 'openai/gpt-oss-20b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question }
        ],
        stream: false
      },
      { timeout: 100000 } // 100 seconds is enough for local
    );

    const llmReply = response.data.choices[0].message.content.trim();

    try {
      const parsed = safeParseLLMJson(llmReply);

      if (!parsed) {
        return llmReply; // no usable JSON – normal answer
      }

      const commands = Array.isArray(parsed) ? parsed : [parsed];

      // For now: execute commands sequentially and build a summary message.
      const results = [];

      for (const cmd of commands) {
        if (!cmd || typeof cmd !== 'object' || !cmd.action) {
          continue;
        }

        switch (cmd.action) {
          case 'add': {
            if (!cmd.date || !cmd.text) {
              results.push('לא הצלחתי להבין את התאריך או התיאור לפעילות החדשה.');
              break;
            }
            if (!isValidDateString(cmd.date)) {
              results.push(`תאריך לא תקין: ${cmd.date}`);
              break;
            }
            await addActivityLLM(cmd.date, cmd.text, cmd.bg, cmd.fg);
            results.push(`הוספתי פעילות: \"${cmd.text}\" בתאריך ${cmd.date}.`);
            break;
          }
          case 'move': {
            const { text, fromDate, toDate } = cmd;
            if (!text || !fromDate || !toDate) {
              results.push('לא הצלחתי להבין מה להזיז ולאיזה תאריך.');
              break;
            }
            if (!isValidDateString(fromDate) || !isValidDateString(toDate)) {
              results.push('אחד מהתאריכים שנתת אינו תקין.');
              break;
            }
            const moved = await moveActivityByTextAndDate(text, fromDate, toDate);
            if (!moved) {
              results.push(`לא מצאתי פעילות בשם \"${text}\" בתאריך ${fromDate}.`);
            } else {
              results.push(`העברתי את \"${text}\" מ-${fromDate} ל-${toDate}.`);
            }
            break;
          }
          case 'delete': {
            const { text, date } = cmd;
            if (!text || !date) {
              results.push('לא הצלחתי להבין מה למחוק ומאיזה תאריך.');
              break;
            }
            if (!isValidDateString(date)) {
              results.push(`תאריך לא תקין: ${date}`);
              break;
            }
            const deleted = await deleteActivityByTextAndDate(text, date);
            if (!deleted) {
              results.push(`לא מצאתי פעילות בשם \"${text}\" בתאריך ${date}.`);
            } else {
              results.push(`מחקתי את \"${text}\" מהתאריך ${date}.`);
            }
            break;
          }
          case 'bulkColor': {
            const { scope } = cmd;
            if (!scope) {
              results.push('לא הבנתי על אילו פעילויות לשנות צבע.');
              break;
            }
            if (scope === 'textContains') {
              const { query, bg, fg } = cmd;
              if (!query) {
                results.push('לא הבנתי לפי איזה טקסט לחפש את הפעילויות לצביעתן.');
                break;
              }
              const count = await bulkColorByTextContains(query, bg, fg);
              results.push(
                count
                  ? `שיניתי את הצבע של ${count} פעילויות המכילות את \"${query}\".`
                  : `לא מצאתי פעילויות המכילות את \"${query}\".`
              );
            } else if (scope === 'dateRange') {
              const { fromDate, toDate, bg, fg } = cmd;
              if (!fromDate || !toDate) {
                results.push('לא הצלחתי להבין את טווח התאריכים לצביעת הפעילויות.');
                break;
              }
              if (!isValidDateString(fromDate) || !isValidDateString(toDate)) {
                results.push('אחד מתאריכי הטווח אינו תקין.');
                break;
              }
              const count = await bulkColorByDateRange(fromDate, toDate, bg, fg);
              results.push(
                count
                  ? `שיניתי את הצבע של ${count} פעילויות בין ${fromDate} ל-${toDate}.`
                  : `לא מצאתי פעילויות בין ${fromDate} ל-${toDate}.`
              );
            }
            break;
          }
          case 'bulkAdd': {
            const { dates, text, bg, fg } = cmd;
            if (!Array.isArray(dates) || !dates.length || !text) {
              results.push('לא הצלחתי להבין באילו תאריכים להוסיף את הפעילויות או מה הטקסט שלהן.');
              break;
            }
            const validDates = dates.filter(isValidDateString);
            if (!validDates.length) {
              results.push('אף אחד מהתאריכים שסופקו לא תקין.');
              break;
            }
            const count = await bulkAddActivities(validDates, text, bg, fg);
            results.push(`הוספתי ${count} פעילויות \"${text}\" בתאריכים שביקשת.`);
            break;
          }
          default:
            // ignore unknown actions; fall back to natural answer if no valid commands were processed
            break;
        }
      }

      if (!results.length) {
        return llmReply; // nothing actionable parsed
      }

      // Join multiple command results with line breaks
      return results.join('\n');
    } catch {
      return llmReply; // parsing failed → treat as normal answer
    }


  } catch (error) {
    console.error('LLM API error:', error.stack || error.message);

    return `סליחה ${userName}, אני לא יכול להתחבר לשרת ה-LLM. : ${error.message}`;
  }
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});