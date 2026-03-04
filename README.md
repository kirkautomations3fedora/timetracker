# ⏱ Time Tracker

A single-page time clock app — no logins, no passwords. Each employee gets a unique URL hash based on their name. The owner gets a separate admin view.

## Architecture

```
index.html  ──POST──▸  Google Apps Script  ──▸  Google Sheets
  (frontend)            (Code.gs, web app)       (Employees + TimeEntries)
```

- **Frontend:** `index.html` — pure HTML/CSS/JS, no dependencies
- **Backend:** Google Apps Script deployed as a web app
- **Storage:** Google Sheets (two tabs: `Employees` and `TimeEntries`)
- **Backups:** Automatic weekly copy to a Google Drive folder

## Setup (5 minutes)

### 1. Create the Google Sheet

1. Go to [sheets.google.com](https://sheets.google.com) and create a new spreadsheet
2. Name it something like "Time Tracker"
3. Go to **Extensions → Apps Script**
4. Delete any existing code and paste the contents of `apps-script/Code.gs`
5. Save (Ctrl+S)

### 2. Deploy as Web App

1. In Apps Script, click **Deploy → New deployment**
2. Click the gear icon → **Web app**
3. Set:
   - **Execute as:** Me
   - **Who has access:** Anyone
4. Click **Deploy**
5. **Authorize** when prompted (review permissions — it needs Sheets + Drive access for backups)
6. Copy the **Web app URL**

### 3. Configure the Frontend

1. Open `index.html`
2. Find this line near the top of the `<script>`:
   ```js
   const API_URL = 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE';
   ```
3. Replace with your actual web app URL

### 4. Set Up Weekly Backups

1. Back in Apps Script, run the function `setupWeeklyBackupTrigger` once:
   - Select it from the function dropdown → click ▶ Run
   - Authorize Drive access if prompted
2. This creates a trigger that backs up every Sunday at 2 AM
3. Backups go to a `TimeTracker_Backups` folder in your Drive
4. Only the last 8 backups are kept (~2 months)

### 5. Host the Frontend

The HTML file can be hosted anywhere:
- **GitHub Pages** (free)
- **Netlify/Vercel** (free)
- **Any static file server**
- Even just open the file locally (`file://`)

## How It Works

### Employee Flow

1. Employee visits the page, enters their name
2. A SHA-256 hash of their name is generated (first 12 chars)
3. They get a unique URL like `https://yoursite.com/#a1b2c3d4e5f6`
4. Bookmark that URL — it's their permanent login
5. Clock in/out with one button

### Owner Flow

1. Owner enters a passphrase on the setup screen
2. Gets a URL like `https://yoursite.com/#owner_a1b2c3d4e5f6`
3. Can view:
   - **Company-wide hours** per 2-week period
   - **All registered employees** with their status and links

### Calendar

- 2-week pay period view
- Click any day to see detailed clock in/out times
- Navigate between periods with arrows
- Period totals calculated automatically

## Google Sheets Structure

### Employees tab
| Hash | Name | ClockedIn | CurrentClockIn |
|------|------|-----------|----------------|
| a1b2c3d4e5f6 | Jane Smith | FALSE | |

### TimeEntries tab
| Hash | Date | ClockIn | ClockOut | DurationMs |
|------|------|---------|----------|------------|
| a1b2c3d4e5f6 | 2026-03-04 | 2026-03-04T09:00:00Z | 2026-03-04T17:30:00Z | 30600000 |

## Notes

- Hashes are deterministic — same name always produces the same hash. Names are lowercased before hashing, so "Jane Smith" and "jane smith" get the same link.
- There's no authentication beyond the hash. This is by design for simplicity, but means anyone with a link can clock in/out for that person. For higher security, consider adding a PIN.
- The Apps Script has CORS handling baked in (uses `text/plain` content type to avoid preflight).
- All times are stored in ISO 8601 UTC. The frontend displays in the user's local timezone.
