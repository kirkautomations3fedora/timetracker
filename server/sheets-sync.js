// ═══════════════════════════════════════
// Google Sheets Sync Module
// Uses the existing clasp OAuth credentials
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

function httpReq(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : (body ? JSON.stringify(body) : null);
    const opts = {
      hostname, path, method,
      headers: {
        ...headers,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve(d); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ═══════════════════════════════════════
// SYNC: Write data to Google Sheets
// Uses the Sheets API v4 via batch update
// Falls back silently if API not available
// ═══════════════════════════════════════
async function syncToSheets(data) {
  try {
    const token = await getToken();

    // Clear and rewrite Employees sheet
    const empValues = [
      ['Hash', 'Name', 'ClockedIn', 'CurrentClockIn'],
      ...data.employees.map(e => [e.hash, e.name, e.clockedIn, e.currentClockIn || '']),
    ];

    // Clear and rewrite TimeEntries sheet
    const entryValues = [
      ['Hash', 'Date', 'ClockIn', 'ClockOut', 'DurationMs'],
      ...data.entries.map(e => [e.hash, e.date, e.clockIn, e.clockOut || '', e.durationMs]),
    ];

    // Use batchUpdate via the Sheets API
    const batchBody = {
      valueInputOption: 'RAW',
      data: [
        { range: 'Employees!A1', values: empValues },
        { range: 'TimeEntries!A1', values: entryValues },
      ],
    };

    // First clear existing data
    await httpReq('POST', 'sheets.googleapis.com',
      `/v4/spreadsheets/${SHEET_ID}/values:batchClear`,
      { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      { ranges: ['Employees!A:Z', 'TimeEntries!A:Z'] });

    // Then write new data
    const result = await httpReq('POST', 'sheets.googleapis.com',
      `/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`,
      { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      batchBody);

    if (result.error) {
      console.log('[Sheets Sync] API error:', result.error.message);
      return false;
    }

    console.log(`[Sheets Sync] Synced ${data.employees.length} employees, ${data.entries.length} entries`);
    return true;
  } catch (err) {
    console.log('[Sheets Sync] Error:', err.message);
    return false;
  }
}

module.exports = { syncToSheets, SHEET_ID };
