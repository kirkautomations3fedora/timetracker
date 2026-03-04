// ══════════════════════════════════════════════════
// Google Apps Script — Time Tracker Backend
// Deploy as Web App (Execute as: Me, Access: Anyone)
// ══════════════════════════════════════════════════

const SHEET_NAME_EMPLOYEES = 'Employees';   // hash | name | clockedIn | currentClockIn
const SHEET_NAME_ENTRIES   = 'TimeEntries';  // hash | date | clockIn | clockOut | durationMs
const BACKUP_FOLDER_NAME   = 'TimeTracker_Backups';

// ──────────────────────────────────────────────────
// Web App Entry Points
// ──────────────────────────────────────────────────
function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  const action = body.action;
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
      default:             result = { error: 'Unknown action' };
    }
  } catch (err) {
    result = { error: err.message };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', message: 'Time Tracker API. Use POST.' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ──────────────────────────────────────────────────
// REGISTER
// ──────────────────────────────────────────────────
function registerEmployee(hash, name) {
  const sheet = getOrCreateSheet(SHEET_NAME_EMPLOYEES, ['Hash', 'Name', 'ClockedIn', 'CurrentClockIn']);
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === hash) {
      return { ok: true, name: data[i][1] }; // already registered
    }
  }

  sheet.appendRow([hash, name, false, '']);
  return { ok: true, name };
}

// ──────────────────────────────────────────────────
// STATUS
// ──────────────────────────────────────────────────
function getStatus(hash) {
  const sheet = getOrCreateSheet(SHEET_NAME_EMPLOYEES, ['Hash', 'Name', 'ClockedIn', 'CurrentClockIn']);
  const data = sheet.getDataRange().getValues();
  let row = null, rowIdx = -1;

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === hash) { row = data[i]; rowIdx = i; break; }
  }

  if (!row) return { error: 'Not registered. Please enter your name first.' };

  const todayEntries = getTodayEntries(hash);
  return {
    name: row[1],
    clockedIn: row[2] === true || row[2] === 'TRUE' || row[2] === 'true',
    clockInTime: row[3] || null,
    todayEntries,
  };
}

// ──────────────────────────────────────────────────
// CLOCK IN
// ──────────────────────────────────────────────────
function clockIn(hash) {
  const empSheet = getOrCreateSheet(SHEET_NAME_EMPLOYEES, ['Hash', 'Name', 'ClockedIn', 'CurrentClockIn']);
  const data = empSheet.getDataRange().getValues();
  let rowIdx = -1;

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === hash) { rowIdx = i + 1; break; } // 1-indexed for sheet
  }

  if (rowIdx === -1) return { error: 'Not registered' };

  const now = new Date();
  empSheet.getRange(rowIdx, 3).setValue(true);
  empSheet.getRange(rowIdx, 4).setValue(now.toISOString());

  const todayEntries = getTodayEntries(hash);
  return { ok: true, todayEntries };
}

// ──────────────────────────────────────────────────
// CLOCK OUT
// ──────────────────────────────────────────────────
function clockOut(hash) {
  const empSheet = getOrCreateSheet(SHEET_NAME_EMPLOYEES, ['Hash', 'Name', 'ClockedIn', 'CurrentClockIn']);
  const empData = empSheet.getDataRange().getValues();
  let rowIdx = -1;
  let clockInTime = null;

  for (let i = 1; i < empData.length; i++) {
    if (empData[i][0] === hash) {
      rowIdx = i + 1;
      clockInTime = empData[i][3];
      break;
    }
  }

  if (rowIdx === -1) return { error: 'Not registered' };
  if (!clockInTime) return { error: 'Not clocked in' };

  const now = new Date();
  const start = new Date(clockInTime);
  const durationMs = now.getTime() - start.getTime();
  const dateStr = start.toISOString().slice(0, 10);

  // Add entry
  const entrySheet = getOrCreateSheet(SHEET_NAME_ENTRIES, ['Hash', 'Date', 'ClockIn', 'ClockOut', 'DurationMs']);
  entrySheet.appendRow([hash, dateStr, start.toISOString(), now.toISOString(), durationMs]);

  // Update employee status
  empSheet.getRange(rowIdx, 3).setValue(false);
  empSheet.getRange(rowIdx, 4).setValue('');

  const todayEntries = getTodayEntries(hash);
  return { ok: true, todayEntries };
}

// ──────────────────────────────────────────────────
// GET ENTRIES (for calendar)
// ──────────────────────────────────────────────────
function getEntries(hash, startDate, endDate) {
  const sheet = getOrCreateSheet(SHEET_NAME_ENTRIES, ['Hash', 'Date', 'ClockIn', 'ClockOut', 'DurationMs']);
  const data = sheet.getDataRange().getValues();
  const start = startDate.slice(0, 10);
  const end = endDate.slice(0, 10);
  const entries = [];

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === hash && data[i][1] >= start && data[i][1] <= end) {
      entries.push({
        date: data[i][1],
        clockIn: formatTimeFromISO(data[i][2]),
        clockOut: data[i][3] ? formatTimeFromISO(data[i][3]) : null,
        durationMs: data[i][4],
      });
    }
  }

  return { entries };
}

// ──────────────────────────────────────────────────
// OWNER REPORT
// ──────────────────────────────────────────────────
function ownerReport(ownerHash, startDate, endDate) {
  if (!ownerHash.startsWith('owner_')) return { error: 'Unauthorized' };

  const empSheet = getOrCreateSheet(SHEET_NAME_EMPLOYEES, ['Hash', 'Name', 'ClockedIn', 'CurrentClockIn']);
  const entrySheet = getOrCreateSheet(SHEET_NAME_ENTRIES, ['Hash', 'Date', 'ClockIn', 'ClockOut', 'DurationMs']);

  const employees = empSheet.getDataRange().getValues();
  const entries = entrySheet.getDataRange().getValues();
  const start = startDate.slice(0, 10);
  const end = endDate.slice(0, 10);

  // Build map of hash → name
  const nameMap = {};
  for (let i = 1; i < employees.length; i++) {
    nameMap[employees[i][0]] = employees[i][1];
  }

  // Aggregate hours per employee
  const hoursMap = {};
  for (let i = 1; i < entries.length; i++) {
    const h = entries[i][0];
    const d = entries[i][1];
    if (d >= start && d <= end) {
      hoursMap[h] = (hoursMap[h] || 0) + (entries[i][4] || 0);
    }
  }

  const report = [];
  for (const h of Object.keys(nameMap)) {
    report.push({ name: nameMap[h], totalMs: hoursMap[h] || 0 });
  }

  report.sort((a, b) => b.totalMs - a.totalMs);
  return { report };
}

// ──────────────────────────────────────────────────
// LIST EMPLOYEES
// ──────────────────────────────────────────────────
function listEmployees(ownerHash) {
  if (!ownerHash.startsWith('owner_')) return { error: 'Unauthorized' };

  const sheet = getOrCreateSheet(SHEET_NAME_EMPLOYEES, ['Hash', 'Name', 'ClockedIn', 'CurrentClockIn']);
  const data = sheet.getDataRange().getValues();
  const employees = [];

  for (let i = 1; i < data.length; i++) {
    employees.push({
      hash: data[i][0],
      name: data[i][1],
      clockedIn: data[i][2] === true || data[i][2] === 'TRUE' || data[i][2] === 'true',
    });
  }

  return { employees };
}

// ──────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────
function getTodayEntries(hash) {
  const sheet = getOrCreateSheet(SHEET_NAME_ENTRIES, ['Hash', 'Date', 'ClockIn', 'ClockOut', 'DurationMs']);
  const data = sheet.getDataRange().getValues();
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const entries = [];

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === hash && data[i][1] === today) {
      entries.push({
        clockIn: data[i][2],
        clockOut: data[i][3] || null,
        durationMs: data[i][4],
      });
    }
  }

  return entries;
}

function getOrCreateSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sheet;
}

function formatTimeFromISO(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'hh:mm a');
  } catch (e) {
    return isoStr;
  }
}

// ──────────────────────────────────────────────────
// WEEKLY BACKUP (set up a time-driven trigger)
// ──────────────────────────────────────────────────
function weeklyBackup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const folder = getOrCreateFolder(BACKUP_FOLDER_NAME);

  const dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const backupName = `TimeTracker_Backup_${dateStr}`;

  // Copy the entire spreadsheet
  const file = DriveApp.getFileById(ss.getId());
  const copy = file.makeCopy(backupName, folder);

  Logger.log(`Backup created: ${backupName} (${copy.getId()})`);

  // Clean up old backups (keep last 8 = ~2 months)
  const files = folder.getFiles();
  const allFiles = [];
  while (files.hasNext()) {
    const f = files.next();
    allFiles.push({ file: f, date: f.getDateCreated() });
  }

  allFiles.sort((a, b) => b.date - a.date);
  for (let i = 8; i < allFiles.length; i++) {
    allFiles[i].file.setTrashed(true);
  }
}

function getOrCreateFolder(name) {
  const folders = DriveApp.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(name);
}

// ──────────────────────────────────────────────────
// SETUP TRIGGER (run once manually)
// ──────────────────────────────────────────────────
function setupWeeklyBackupTrigger() {
  // Remove existing triggers for this function
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'weeklyBackup') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // Create weekly trigger (every Sunday at 2 AM)
  ScriptApp.newTrigger('weeklyBackup')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(2)
    .create();

  Logger.log('Weekly backup trigger created (Sundays at 2 AM)');
}
