const fs = require('fs');
const https = require('https');

function httpsJson(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method, headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const creds = JSON.parse(fs.readFileSync('/home/michael/.clasprc.json', 'utf8')).tokens.default;
  
  // Refresh token
  const tokenResp = await new Promise((resolve, reject) => {
    const data = new URLSearchParams({
      client_id: creds.client_id, client_secret: creds.client_secret,
      refresh_token: creds.refresh_token, grant_type: 'refresh_token'
    }).toString();
    const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': data.length }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject);
    req.write(data); req.end();
  });
  const token = tokenResp.access_token;
  console.log('Token refreshed');

  // Create standalone script
  let resp = await httpsJson('POST', 'https://script.googleapis.com/v1/projects', token, { title: 'TimeTracker-Standalone' });
  if (resp.error) { console.log('Create error:', JSON.stringify(resp.error)); return; }
  const sid = resp.scriptId;
  console.log('Script created:', sid);

  // Read and modify code
  let code = fs.readFileSync('/home/michael/.openclaw/workspace/timetracker/apps-script/Code.gs', 'utf8');
  code = code.replace(/SpreadsheetApp\.getActiveSpreadsheet\(\)/g,
    "SpreadsheetApp.openById('1emE6D1FNu0jO0qcoYv0FKmq4nryGyDLZDmX1c3VyNMA')");

  const manifest = JSON.stringify({
    timeZone: 'America/Los_Angeles', dependencies: {},
    exceptionLogging: 'STACKDRIVER', runtimeVersion: 'V8',
    webapp: { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' },
    oauthScopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
  });

  // Push code
  resp = await httpsJson('PUT', `https://script.googleapis.com/v1/projects/${sid}/content`, token, {
    files: [
      { name: 'appsscript', type: 'JSON', source: manifest },
      { name: 'Code', type: 'SERVER_JS', source: code }
    ]
  });
  if (resp.error) { console.log('Push error:', JSON.stringify(resp.error)); return; }
  console.log('Code pushed');

  // Create version
  resp = await httpsJson('POST', `https://script.googleapis.com/v1/projects/${sid}/versions`, token, { description: 'v1 standalone' });
  if (resp.error) { console.log('Version error:', JSON.stringify(resp.error)); return; }
  const ver = resp.versionNumber;
  console.log('Version:', ver);

  // Deploy
  resp = await httpsJson('POST', `https://script.googleapis.com/v1/projects/${sid}/deployments`, token, {
    versionNumber: ver, manifestFileName: 'appsscript', description: 'TimeTracker standalone v1'
  });
  if (resp.error) { console.log('Deploy error:', JSON.stringify(resp.error)); return; }
  
  const deployId = resp.deploymentId;
  console.log('Deployment:', deployId);
  for (const ep of (resp.entryPoints || [])) {
    if (ep.entryPointType === 'WEB_APP') {
      console.log('URL:', ep.webApp.url);
      console.log('Access:', ep.webApp.entryPointConfig.access);
      fs.writeFileSync('/home/michael/.openclaw/workspace/timetracker/standalone-deploy.json',
        JSON.stringify({ scriptId: sid, deploymentId: deployId, url: ep.webApp.url }, null, 2));
    }
  }
  console.log('Done!');
}
main().catch(e => console.error(e));
