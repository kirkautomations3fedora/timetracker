const https = require('https');
const fs = require('fs');

function httpReq(method, hostname, reqpath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : (body ? JSON.stringify(body) : null);
    const req = https.request({ hostname, path: reqpath, method, headers: {
      ...headers, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const creds = JSON.parse(fs.readFileSync(process.env.HOME + '/.clasprc.json', 'utf8')).tokens.default;
  const tokenBody = new URLSearchParams({
    client_id: creds.client_id, client_secret: creds.client_secret,
    refresh_token: creds.refresh_token, grant_type: 'refresh_token'
  }).toString();
  const tokenResp = await httpReq('POST', 'oauth2.googleapis.com', '/token',
    { 'Content-Type': 'application/x-www-form-urlencoded' }, tokenBody);
  const token = tokenResp.access_token;
  console.log('Token refreshed');

  // Try Service Management API to enable Sheets API
  console.log('\n--- Trying servicemanagement.googleapis.com ---');
  let resp = await httpReq('POST', 'servicemanagement.googleapis.com',
    '/v1/services/sheets.googleapis.com:enable',
    { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    { consumerId: 'project:1072944905499' });
  console.log('ServiceMgmt:', JSON.stringify(resp).slice(0, 300));

  // Also try enabling via the consumer settings
  console.log('\n--- Trying serviceusage with different approach ---');
  resp = await httpReq('POST', 'serviceusage.googleapis.com',
    '/v1/projects/1072944905499/services/sheets.googleapis.com:enable',
    { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, {});
  console.log('ServiceUsage:', JSON.stringify(resp).slice(0, 300));

  // Try with consumer API
  console.log('\n--- Trying consumer API ---');
  resp = await httpReq('PATCH', 'serviceusage.googleapis.com',
    '/v1beta1/projects/1072944905499/services/sheets.googleapis.com',
    { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    { state: 'ENABLED' });
  console.log('Consumer:', JSON.stringify(resp).slice(0, 300));
}
main().catch(e => console.error(e));
