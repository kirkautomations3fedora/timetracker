#!/usr/bin/env python3
"""Create a new standalone Google Apps Script, push code, deploy as web app."""
import json, urllib.request, urllib.parse

def get_token():
    with open('/home/michael/.clasprc.json') as f:
        creds = json.load(f)['tokens']['default']
    refresh_data = urllib.parse.urlencode({
        'client_id': creds['client_id'],
        'client_secret': creds['client_secret'],
        'refresh_token': creds['refresh_token'],
        'grant_type': 'refresh_token'
    }).encode()
    req = urllib.request.Request('https://oauth2.googleapis.com/token', data=refresh_data)
    resp = json.loads(urllib.request.urlopen(req).read())
    return resp['access_token']

def api(method, url, token, body=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers={
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json'
    }, method=method)
    try:
        return json.loads(urllib.request.urlopen(req).read())
    except urllib.error.HTTPError as e:
        print(f"Error {e.code}: {e.read().decode()[:500]}")
        return None

def main():
    token = get_token()
    print("Token refreshed")

    # 1. Create standalone script
    resp = api('POST', 'https://script.googleapis.com/v1/projects', token, {'title': 'TimeTracker-Standalone'})
    if not resp:
        return
    sid = resp['scriptId']
    print(f"Created script: {sid}")

    # 2. Read and modify code
    with open('/home/michael/.openclaw/workspace/timetracker/apps-script/Code.gs') as f:
        code = f.read()
    code = code.replace(
        "SpreadsheetApp.getActiveSpreadsheet()",
        "SpreadsheetApp.openById('1emE6D1FNu0jO0qcoYv0FKmq4nryGyDLZDmX1c3VyNMA')"
    )

    manifest = json.dumps({
        "timeZone": "America/Los_Angeles",
        "dependencies": {},
        "exceptionLogging": "STACKDRIVER",
        "runtimeVersion": "V8",
        "webapp": {"executeAs": "USER_DEPLOYING", "access": "ANYONE_ANONYMOUS"},
        "oauthScopes": [
            "https://www.googleapis.com/auth/spreadsheets",
            "https://www.googleapis.com/auth/drive"
        ]
    })

    # 3. Push code
    resp = api('PUT', f'https://script.googleapis.com/v1/projects/{sid}/content', token, {
        "files": [
            {"name": "appsscript", "type": "JSON", "source": manifest},
            {"name": "Code", "type": "SERVER_JS", "source": code}
        ]
    })
    if not resp:
        return
    print("Code pushed")

    # 4. Create version
    resp = api('POST', f'https://script.googleapis.com/v1/projects/{sid}/versions', token,
               {"description": "v1 standalone"})
    if not resp:
        return
    ver = resp['versionNumber']
    print(f"Version: {ver}")

    # 5. Deploy
    resp = api('POST', f'https://script.googleapis.com/v1/projects/{sid}/deployments', token, {
        "versionNumber": ver,
        "manifestFileName": "appsscript",
        "description": "TimeTracker standalone v1"
    })
    if not resp:
        return

    deploy_id = resp.get('deploymentId')
    print(f"Deployment: {deploy_id}")
    for ep in resp.get('entryPoints', []):
        if ep.get('entryPointType') == 'WEB_APP':
            url = ep['webApp']['url']
            access = ep['webApp']['entryPointConfig']['access']
            print(f"URL: {url}")
            print(f"Access: {access}")

    # Save the script ID and URL for later use
    with open('/home/michael/.openclaw/workspace/timetracker/standalone-deploy.json', 'w') as f:
        json.dump({'scriptId': sid, 'deploymentId': deploy_id, 'url': url}, f, indent=2)
    print("Saved to standalone-deploy.json")

if __name__ == '__main__':
    main()
