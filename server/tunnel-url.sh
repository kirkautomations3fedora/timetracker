#!/bin/bash
# Grab the current cloudflare tunnel URL from journalctl
journalctl --user -u cloudflared-timetracker.service --no-pager -n 30 2>/dev/null \
  | grep -oP 'https://[a-z\-]+\.trycloudflare\.com' | tail -1
