const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const fss = require('fs');  // sync version for atomic rename
const path = require('path');
const axios = require('axios');
const passport = require('passport');
const WindowsStrategy = require('passport-windowsauth');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'activities.json');
const BACKUP_DIR = path.join(__dirname, 'backups');
const MAX_BACKUPS = 20;  // keep last 20 backups

// Configure Passport with Windows Authentication
try {
  passport.use('windowsauth', new WindowsStrategy({
    integrated: true, // Use integrated Windows authentication
    getUserNameFromHeader: (req) => {
      // Extract username from NTLM headers
      return req.headers['x-iisnode-auth_user'] || req.headers['remote_user'] || 'Unknown';
    }
  }, (profile, done) => {
    // Verify function - profile contains user information
    console.log('Windows auth profile:', profile);
    return done(null, profile);
  }));
  console.log('Windows authentication strategy registered successfully');
} catch (error) {
  console.error('Failed to register Windows authentication strategy:', error);
  // Fallback: Use system username for development
  passport.use('windowsauth', {
    authenticate: function(req, options) {
      const user = {
        name: process.env.USERNAME || process.env.USER || 'Unknown User',
        domain: process.env.USERDOMAIN || 'LOCAL'
      };
      console.log('Using fallback authentication with user:', user);
      return this.success(user);
    }
  });
}

// Debug: Check if strategy is registered
console.log('Registered strategies:', Object.keys(passport._strategies));

// Serialize user
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

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
app.use(passport.initialize());
app.use(passport.session());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Authentication middleware
function requireAuth(req, res, next) {
  passport.authenticate('windowsauth', { session: false }, (err, user, info) => {
    if (err) {
      console.error('Auth error:', err);
      return res.status(500).json({ error: 'Authentication error' });
    }
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    req.user = user;
    next();
  })(req, res, next);
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

// Routes
app.get('/api/user', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/activities', requireAuth, async (req, res) => {
  try {
    const data = await readData();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


app.post('/api/activities', requireAuth, async (req, res) => {
  const { date, text, bg, fg } = req.body;
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
      date: new Date().toISOString().slice(0,10),
      desc: `הפעילות "${text}" נוספה`
    });
    await writeData(data);
    res.json({ id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/activities/:id', requireAuth, async (req, res) => {
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
            date: new Date().toISOString().slice(0,10),
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
      date: new Date().toISOString().slice(0,10),
      desc: `הפעילות "${act.text}" הועברה מ-${oldDate} ל-${date}`
    });
    await writeData(data);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/activities/:id', requireAuth, async (req, res) => {
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
          date: new Date().toISOString().slice(0,10),
          desc: `Deleted "${removed.text}"`
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

// Helper function to generate chat responses using Ollama LLM
async function generateChatResponse(question, data, user) {
  try {
    // Prepare context about activities
    const activitiesSummary = Object.entries(data.activities)
      .map(([date, activities]) => 
        `${date}: ${activities.map(a => a.text).join(', ')}`
      )
      .join('\n');
    
    const today = new Date().toISOString().slice(0, 10);
    const userName = user && user.name ? user.name : 'משתמש';
    
    const prompt = `You are a helpful assistant for a weekly planner app. The user is ${userName}.

The user has activities scheduled as follows:

${activitiesSummary || 'No activities scheduled yet.'}

Today is ${today}.

Please answer the user's question in Hebrew, being helpful and concise. If the question is about activities, use the information above. If it's a general question, provide a helpful response.

User question: ${question}`;

    // Call Ollama API
    const response = await axios.post('http://localhost:1234/v1/chat/completions', {
      model: 'mistral', // You can change this to any model you have installed in Ollama
      messages: [{ role: 'user', content: prompt }],
      stream: false
    }, {
      timeout: 100000 // 10 second timeout
    });

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('LLM API error:', error.message);
    
    // Fallback to simple responses if LLM is not available
    const q = question.toLowerCase();
    const today = new Date().toISOString().slice(0, 10);
    const userName = user && user.name ? user.name : 'משתמש';
    
    if (q.includes('היום') || q.includes('הלום') || q.includes('today')) {
      const todayActivities = data.activities[today] || [];
      if (todayActivities.length === 0) {
        return `${userName}, אין לך פעילויות היום. יום שקט!`;
      }
      return `${userName}, היום יש לך ${todayActivities.length} פעילות:\n${todayActivities.map((a, i) => `${i + 1}. ${a.text}`).join('\n')}`;
    }
    
    if (q.includes('כמה') || q.includes('count')) {
      let total = 0;
      for (const date in data.activities) {
        total += data.activities[date].length;
      }
      return `${userName}, יש לך בסך הכל ${total} פעילויות.`;
    }
    
    if (q.includes('מתי') || q.includes('when') || q.includes('פעילויות')) {
      const dates = Object.keys(data.activities).sort();
      if (dates.length === 0) {
        return `${userName}, אין לך כל פעילויות מתוכננות.`;
      }
      return `${userName}, יש לך פעילויות בימים אלה:\n${dates.join('\n')}`;
    }
    
    return `סליחה ${userName}, אני לא יכול להתחבר לשרת ה-LLM. אנא וודא ש-Ollama פועל עם מודל "mistral" מותקן. שאל שאלות על הפעילויות שלך!`;
  }
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});