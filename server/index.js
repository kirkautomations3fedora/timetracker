// ═══════════════════════════════════════
// Time Tracker Backend — Node.js + JSON
// ═══════════════════════════════════════
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { syncToSheets, SHEET_ID } = require('./sheets-sync');

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, 'data.json');

// Owner passkey: SHA-256('openclaw1').slice(0,12) prefixed with 'owner_'
const OWNER_HASH = 'owner_' + crypto.createHash('sha256').update('openclaw1').digest('hex').slice(0, 12);

// Admin hashes — employees who get admin (view all + edit) access
const ADMIN_HASHES = [
  '1e28b0f96e44',  // ester
  '4c3b3284e206',  // mk
  '34550715062a',  // Michael
  '64b4d0f47c93',  // Mike
];

function isValidOwner(hash) {
  return hash === OWNER_HASH;
}

function isAdmin(hash) {
  if (hash && hash.startsWith('owner_')) return hash === OWNER_HASH;
  return ADMIN_HASHES.includes(hash);
}

// Debounced sync to Google Sheets
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
// API ENDPOINT
// ═══════════════════════════════════════
app.post('/api', (req, res) => {
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
      case 'register':          result = registerEmployee(body.hash, body.name); break;
      case 'status':            result = getStatus(body.hash); break;
      case 'clockIn':           result = clockIn(body.hash); break;
      case 'clockOut':          result = clockOut(body.hash); break;
      case 'getEntries':        result = getEntries(body.hash, body.startDate, body.endDate); break;
      case 'ownerReport':       result = ownerReport(body.hash, body.startDate, body.endDate); break;
      case 'weekReport':        result = weekReport(body.hash); break;
      case 'listEmployees':     result = listEmployees(body.hash); break;
      case 'editEntry':         result = editEntry(body.hash, body.targetHash, body.date, body.clockIn, body.clockOut); break;
      case 'deleteEntry':       result = deleteEntry(body.hash, body.targetHash, body.date, body.clockIn); break;
      case 'addEntry':          result = addEntry(body.hash, body.targetHash, body.date, body.clockIn, body.clockOut); break;
      case 'getEmployeeEntries':result = getEmployeeEntries(body.hash, body.targetHash, body.startDate, body.endDate); break;
      default:                  result = { error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { error: err.message };
  }

  res.json(result);
});

app.get('/api', (req, res) => {
  res.json({ status: 'ok', message: 'Time Tracker API. Use POST.' });
});

// ═══════════════════════════════════════
// REGISTER
// ═══════════════════════════════════════
function registerEmployee(hash, name) {
  const data = loadData();
  const existing = data.employees.find(e => e.hash === hash);
  if (existing) return { ok: true, name: existing.name, isAdmin: isAdmin(hash) };

  data.employees.push({ hash, name, clockedIn: false, currentClockIn: '' });
  saveData(data);
  scheduleSheetsSync();
  return { ok: true, name, isAdmin: isAdmin(hash) };
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
    isAdmin: isAdmin(hash),
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
// GET ENTRIES (calendar — own entries)
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
      clockInISO: e.clockIn,
      clockOut: e.clockOut ? formatTime(e.clockOut) : null,
      clockOutISO: e.clockOut || null,
      durationMs: e.durationMs,
    }));

  return { entries };
}

// ═══════════════════════════════════════
// GET EMPLOYEE ENTRIES (admin only)
// ═══════════════════════════════════════
function getEmployeeEntries(adminHash, targetHash, startDate, endDate) {
  if (!isAdmin(adminHash)) return { error: 'Unauthorized' };

  const data = loadData();
  const start = startDate.slice(0, 10);
  const end = endDate.slice(0, 10);

  const entries = data.entries
    .filter(e => e.hash === targetHash && e.date >= start && e.date <= end)
    .map((e, i) => ({
      date: e.date,
      clockIn: formatTime(e.clockIn),
      clockInISO: e.clockIn,
      clockOut: e.clockOut ? formatTime(e.clockOut) : null,
      clockOutISO: e.clockOut || null,
      durationMs: e.durationMs,
    }));

  return { entries };
}

// ═══════════════════════════════════════
// OWNER / ADMIN REPORT (2-week period)
// ═══════════════════════════════════════
function ownerReport(adminHash, startDate, endDate) {
  if (!isAdmin(adminHash)) return { error: 'Unauthorized' };

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
    hash: h,
    name: nameMap[h],
    totalMs: hoursMap[h] || 0,
  }));
  report.sort((a, b) => b.totalMs - a.totalMs);

  return { report };
}

// ═══════════════════════════════════════
// WEEK REPORT — last 7 days, broken down by day per employee
// ═══════════════════════════════════════
function weekReport(adminHash) {
  if (!isAdmin(adminHash)) return { error: 'Unauthorized' };

  const data = loadData();
  const now = new Date();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  const nameMap = {};
  const hashList = [];
  data.employees.forEach(e => {
    nameMap[e.hash] = e.name;
    hashList.push(e.hash);
  });

  const breakdown = {};
  data.entries.forEach(e => {
    if (days.includes(e.date)) {
      if (!breakdown[e.hash]) breakdown[e.hash] = {};
      breakdown[e.hash][e.date] = (breakdown[e.hash][e.date] || 0) + (e.durationMs || 0);
    }
  });

  const report = hashList.map(h => {
    const daily = {};
    let weekTotal = 0;
    days.forEach(d => {
      const ms = (breakdown[h] && breakdown[h][d]) || 0;
      daily[d] = ms;
      weekTotal += ms;
    });
    return { hash: h, name: nameMap[h], daily, weekTotal };
  });

  report.sort((a, b) => b.weekTotal - a.weekTotal);
  return { days, report };
}

// ═══════════════════════════════════════
// LIST EMPLOYEES (admin only)
// ═══════════════════════════════════════
function listEmployees(adminHash) {
  if (!isAdmin(adminHash)) return { error: 'Unauthorized' };

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
// EDIT ENTRY (admin only)
// ═══════════════════════════════════════
function editEntry(adminHash, targetHash, date, newClockIn, newClockOut) {
  if (!isAdmin(adminHash)) return { error: 'Unauthorized' };

  const data = loadData();
  const dateStr = date.slice(0, 10);

  const entry = data.entries.find(e => e.hash === targetHash && e.date === dateStr);
  if (!entry) return { error: 'Entry not found' };

  const ciDate = new Date(newClockIn);
  const coDate = new Date(newClockOut);
  entry.clockIn = newClockIn;
  entry.clockOut = newClockOut;
  entry.durationMs = coDate.getTime() - ciDate.getTime();

  saveData(data);
  scheduleSheetsSync();
  return { ok: true };
}

// ═══════════════════════════════════════
// DELETE ENTRY (admin only)
// ═══════════════════════════════════════
function deleteEntry(adminHash, targetHash, date, clockIn) {
  if (!isAdmin(adminHash)) return { error: 'Unauthorized' };

  const data = loadData();
  const dateStr = date.slice(0, 10);

  const idx = data.entries.findIndex(e => e.hash === targetHash && e.date === dateStr && e.clockIn === clockIn);
  if (idx === -1) return { error: 'Entry not found' };

  data.entries.splice(idx, 1);
  saveData(data);
  scheduleSheetsSync();
  return { ok: true };
}

// ═══════════════════════════════════════
// ADD ENTRY (admin only)
// ═══════════════════════════════════════
function addEntry(adminHash, targetHash, date, clockIn, clockOut) {
  if (!isAdmin(adminHash)) return { error: 'Unauthorized' };

  const data = loadData();
  const ciDate = new Date(clockIn);
  const coDate = new Date(clockOut);

  data.entries.push({
    hash: targetHash,
    date: date.slice(0, 10),
    clockIn,
    clockOut,
    durationMs: coDate.getTime() - ciDate.getTime(),
  });

  saveData(data);
  scheduleSheetsSync();
  return { ok: true };
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
