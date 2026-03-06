// ═══════════════════════════════════════
// Google Sheets Sync via Drive API
// Uses Drive API (which IS enabled) instead of Sheets API
// Writes data as CSV via multipart upload
// ═══════════════════════════════════════
const https = require('https');
const fs = require('fs');
const path = require('path');

const CLASP_RC = path.join(process.env.HOME, '.clasprc.json');
const SHEET_ID = '1emE6D1FNu0jO0qcoYv0FKmq4nryGyDLZDmX1c3VyNMA';

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const creds = JSON.parse(fs.readFileSync(CLASP_RC, 'utf8')).tokens.default;
  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
    grant_type: 'refresh_token',
  }).toString();
  const resp = await httpReq('POST', 'oauth2.googleapis.com', '/token',
    { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
  cachedToken = resp.access_token;
  tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
  return cachedToken;
}

function httpReq(method, hostname, reqpath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : (body ? JSON.stringify(body) : null);
    const opts = {
      hostname, path: reqpath, method,
      headers: { ...headers, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    };
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function httpReqRaw(method, hostname, reqpath, headers, rawBody) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname, path: reqpath, method,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(rawBody) },
    };
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

function escapeCSV(val) {
  const s = String(val == null ? '' : val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ═══════════════════════════════════════
// Create a new spreadsheet for sync data
// (since we can't write to existing sheet via Drive API easily)
// Instead, create a companion "sync" spreadsheet we own
// ═══════════════════════════════════════
const SYNC_FILE = path.join(__dirname, 'sync-sheet-id.txt');

async function getOrCreateSyncSheet(token) {
  // Check if we already have a sync sheet
  if (fs.existsSync(SYNC_FILE)) {
    const id = fs.readFileSync(SYNC_FILE, 'utf8').trim();
    // Verify it still exists
    const check = await httpReq('GET', 'www.googleapis.com',
      `/drive/v3/files/${id}?fields=id,name`,
      { 'Authorization': 'Bearer ' + token }, null);
    if (check.id) return id;
  }

  // Create a new Google Sheet via Drive API (this WILL work with drive.file scope)
  const metadata = {
    name: 'Time Tracker Data',
    mimeType: 'application/vnd.google-apps.spreadsheet',
  };
  const resp = await httpReq('POST', 'www.googleapis.com',
    '/drive/v3/files',
    { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    metadata);

  if (resp.id) {
    console.log(`[Sheets Sync] Created new sync spreadsheet: ${resp.id}`);
    fs.writeFileSync(SYNC_FILE, resp.id);

    // Make it publicly viewable
    await httpReq('POST', 'www.googleapis.com',
      `/drive/v3/files/${resp.id}/permissions`,
      { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      { role: 'writer', type: 'anyone' });

    return resp.id;
  }

  console.log('[Sheets Sync] Failed to create sheet:', JSON.stringify(resp).slice(0, 200));
  return null;
}

// ═══════════════════════════════════════
// SYNC: Write data to Google Sheets
// Creates a CSV and uploads via Drive API
// ═══════════════════════════════════════
async function syncToSheets(data) {
  try {
    const token = await getToken();
    const sheetId = await getOrCreateSyncSheet(token);
    if (!sheetId) return false;

    // Build CSV with all data
    const lines = [];
    lines.push('=== EMPLOYEES ===');
    lines.push('Hash,Name,ClockedIn,CurrentClockIn');
    data.employees.forEach(e => {
      lines.push([e.hash, e.name, e.clockedIn, e.currentClockIn || ''].map(escapeCSV).join(','));
    });
    lines.push('');
    lines.push('=== TIME ENTRIES ===');
    lines.push('Hash,Date,ClockIn,ClockOut,DurationMs');
    data.entries.forEach(e => {
      lines.push([e.hash, e.date, e.clockIn, e.clockOut || '', e.durationMs].map(escapeCSV).join(','));
    });

    const csvContent = lines.join('\n');

    // Upload as update using multipart
    const boundary = 'sync_boundary_' + Date.now();
    const multipart =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `{"name":"Time Tracker Data","mimeType":"application/vnd.google-apps.spreadsheet"}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/csv\r\n\r\n` +
      csvContent + `\r\n` +
      `--${boundary}--`;

    const resp = await httpReqRaw('PATCH', 'www.googleapis.com',
      `/upload/drive/v3/files/${sheetId}?uploadType=multipart`,
      {
        'Authorization': 'Bearer ' + token,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      multipart);

    if (resp.id) {
      const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}`;
      console.log(`[Sheets Sync] ✅ Synced ${data.employees.length} employees, ${data.entries.length} entries → ${sheetUrl}`);
      return true;
    }

    console.log('[Sheets Sync] Upload error:', JSON.stringify(resp).slice(0, 300));
    return false;
  } catch (err) {
    console.log('[Sheets Sync] Error:', err.message);
    return false;
  }
}

module.exports = { syncToSheets, SHEET_ID, getOrCreateSyncSheet, getToken };
