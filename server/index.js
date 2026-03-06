// ═══════════════════════════════════════
// Time Tracker Backend — Node.js + JSON
// Replaces Google Apps Script entirely
// ═══════════════════════════════════════
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const { syncToSheets, SHEET_ID } = require('./sheets-sync');

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, 'data.json');

// Debounced sync to Google Sheets (sync 2s after last write)
let syncTimer = null;
function scheduleSheetsSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    const data = loadData();
    syncToSheets(data).catch(() => {});
  }, 2000);
}

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  preflightContinue: false,
  optionsSuccessStatus: 204,
}));
app.use(express.json());
app.use(express.text({ type: 'text/plain' }));

// Serve the frontend
app.use(express.static(path.join(__dirname, '..')));

// ═══════════════════════════════════════
// DATA LAYER
// ═══════════════════════════════════════
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    const initial = { employees: [], entries: [] };
    saveData(initial);
    return initial;
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ═══════════════════════════════════════
// API ENDPOINT (compatible with Apps Script frontend)
// ═══════════════════════════════════════
app.post('/api', (req, res) => {
  // Handle both JSON and text/plain (Apps Script CORS workaround)
  let body;
  if (typeof req.body === 'string') {
    try { body = JSON.parse(req.body); } catch { return res.json({ error: 'Invalid JSON' }); }
  } else {
    body = req.body;
  }

  const { action } = body;
  let result;

  try {
    switch (action) {
      case 'register':     result = registerEmployee(body.hash, body.name); break;
      case 'status':       result = getStatus(body.hash); break;
      case 'clockIn':      result = clockIn(body.hash); break;
      case 'clockOut':     result = clockOut(body.hash); break;
      case 'getEntries':   result = getEntries(body.hash, body.startDate, body.endDate); break;
      case 'ownerReport':  result = ownerReport(body.hash, body.startDate, body.endDate); break;
      case 'listEmployees':result = listEmployees(body.hash); break;
      default:             result = { error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { error: err.message };
  }

  res.json(result);
});

// Also handle GET for health check
app.get('/api', (req, res) => {
  res.json({ status: 'ok', message: 'Time Tracker API. Use POST.' });
});

// ═══════════════════════════════════════
// REGISTER
// ═══════════════════════════════════════
function registerEmployee(hash, name) {
  const data = loadData();
  const existing = data.employees.find(e => e.hash === hash);
  if (existing) return { ok: true, name: existing.name };

  data.employees.push({ hash, name, clockedIn: false, currentClockIn: '' });
  saveData(data);
  scheduleSheetsSync();
  return { ok: true, name };
}

// ═══════════════════════════════════════
// STATUS
// ═══════════════════════════════════════
function getStatus(hash) {
  const data = loadData();
  const emp = data.employees.find(e => e.hash === hash);
  if (!emp) return { error: 'Not registered. Please enter your name first.' };

  const todayEntries = getTodayEntries(data, hash);
  return {
    name: emp.name,
    clockedIn: emp.clockedIn,
    clockInTime: emp.currentClockIn || null,
    todayEntries,
  };
}

// ═══════════════════════════════════════
// CLOCK IN
// ═══════════════════════════════════════
function clockIn(hash) {
  const data = loadData();
  const emp = data.employees.find(e => e.hash === hash);
  if (!emp) return { error: 'Not registered' };

  const now = new Date().toISOString();
  emp.clockedIn = true;
  emp.currentClockIn = now;
  saveData(data);
  scheduleSheetsSync();

  const todayEntries = getTodayEntries(data, hash);
  return { ok: true, todayEntries };
}

// ═══════════════════════════════════════
// CLOCK OUT
// ═══════════════════════════════════════
function clockOut(hash) {
  const data = loadData();
  const emp = data.employees.find(e => e.hash === hash);
  if (!emp) return { error: 'Not registered' };
  if (!emp.currentClockIn) return { error: 'Not clocked in' };

  const now = new Date();
  const start = new Date(emp.currentClockIn);
  const durationMs = now.getTime() - start.getTime();
  const dateStr = start.toISOString().slice(0, 10);

  data.entries.push({
    hash,
    date: dateStr,
    clockIn: emp.currentClockIn,
    clockOut: now.toISOString(),
    durationMs,
  });

  emp.clockedIn = false;
  emp.currentClockIn = '';
  saveData(data);
  scheduleSheetsSync();

  const todayEntries = getTodayEntries(data, hash);
  return { ok: true, todayEntries };
}

// ═══════════════════════════════════════
// GET ENTRIES (calendar)
// ═══════════════════════════════════════
function getEntries(hash, startDate, endDate) {
  const data = loadData();
  const start = startDate.slice(0, 10);
  const end = endDate.slice(0, 10);

  const entries = data.entries
    .filter(e => e.hash === hash && e.date >= start && e.date <= end)
    .map(e => ({
      date: e.date,
      clockIn: formatTime(e.clockIn),
      clockOut: e.clockOut ? formatTime(e.clockOut) : null,
      durationMs: e.durationMs,
    }));

  return { entries };
}

// ═══════════════════════════════════════
// OWNER REPORT
// ═══════════════════════════════════════
function ownerReport(ownerHash, startDate, endDate) {
  if (!ownerHash.startsWith('owner_')) return { error: 'Unauthorized' };

  const data = loadData();
  const start = startDate.slice(0, 10);
  const end = endDate.slice(0, 10);

  const hoursMap = {};
  data.entries
    .filter(e => e.date >= start && e.date <= end)
    .forEach(e => {
      hoursMap[e.hash] = (hoursMap[e.hash] || 0) + (e.durationMs || 0);
    });

  const nameMap = {};
  data.employees.forEach(e => { nameMap[e.hash] = e.name; });

  const report = Object.keys(nameMap).map(h => ({
    name: nameMap[h],
    totalMs: hoursMap[h] || 0,
  }));
  report.sort((a, b) => b.totalMs - a.totalMs);

  return { report };
}

// ═══════════════════════════════════════
// LIST EMPLOYEES
// ═══════════════════════════════════════
function listEmployees(ownerHash) {
  if (!ownerHash.startsWith('owner_')) return { error: 'Unauthorized' };

  const data = loadData();
  return {
    employees: data.employees.map(e => ({
      hash: e.hash,
      name: e.name,
      clockedIn: e.clockedIn,
    })),
  };
}

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════
function getTodayEntries(data, hash) {
  const today = new Date().toISOString().slice(0, 10);
  return data.entries
    .filter(e => e.hash === hash && e.date === today)
    .map(e => ({
      clockIn: e.clockIn,
      clockOut: e.clockOut || null,
      durationMs: e.durationMs,
    }));
}

function formatTime(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return isoStr;
  }
}

// ═══════════════════════════════════════
// START
// ═══════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
  console.log(`⏱ Time Tracker server running on http://localhost:${PORT}`);
});
