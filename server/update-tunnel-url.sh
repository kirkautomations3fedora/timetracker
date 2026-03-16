#!/bin/bash
# Auto-update GitHub Pages redirect when tunnel URL changes
REPO_DIR="/home/michael/.openclaw/workspace/timetracker"
INDEX="$REPO_DIR/index.html"

NEW_URL=$(journalctl --user -u cloudflared-timetracker.service --no-pager 2>/dev/null | grep -oP 'https://[a-z\-]+\.trycloudflare\.com' | tail -1)

if [ -z "$NEW_URL" ]; then
  echo "No tunnel URL found"
  exit 1
fi

CURRENT_URL=$(grep -oP "const TUNNEL_URL = '\\K[^']*" "$INDEX")

if [ "$NEW_URL" != "$CURRENT_URL" ]; then
  echo "Tunnel URL changed: $CURRENT_URL -> $NEW_URL"
  sed -i "s|const TUNNEL_URL = '.*'|const TUNNEL_URL = '$NEW_URL'|" "$INDEX"
  cd "$REPO_DIR"
  git add index.html
  git commit -m "Auto-update tunnel URL to $NEW_URL"
  git push origin main
  echo "Updated and pushed!"
else
  echo "URL unchanged: $CURRENT_URL"
fi
