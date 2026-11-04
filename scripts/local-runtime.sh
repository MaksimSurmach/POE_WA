#!/bin/sh
# Controls the existing native macOS installation; never removes its database.
set -eu

runtime="$HOME/Library/Application Support/POE Worksmith"
domain="gui/$(id -u)"
prefix="com.maksimsurmach.poe-worksmith"

start_service() {
  label="$prefix.$1"
  if ! launchctl print "$domain/$label" >/dev/null 2>&1; then
    launchctl bootstrap "$domain" "$runtime/launchagents/$label.plist"
  fi
  launchctl kickstart "$domain/$label"
}

stop_service() {
  label="$prefix.$1"
  if state=$(launchctl print "$domain/$label" 2>/dev/null); then
    pid=$(printf '%s\n' "$state" | awk '/^[[:space:]]*pid = / {print $3; exit}')
    launchctl bootout "$domain/$label"
    attempts=0
    while [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; do
      attempts=$((attempts + 1))
      if [ "$attempts" -ge 45 ]; then
        echo "$label did not stop; dependent services were left running." >&2
        exit 1
      fi
      sleep 1
    done
  fi
}

case "${1:-status}" in
  start)
    start_service postgres
    attempts=0
    until "${PG_ISREADY:-/opt/homebrew/opt/postgresql@17/bin/pg_isready}" -h 127.0.0.1 -p 54326 -U postgres -q; do
      attempts=$((attempts + 1))
      if [ "$attempts" -ge 30 ]; then
        echo "PostgreSQL is not ready. Inspect $runtime/logs/postgres.stderr.log" >&2
        exit 1
      fi
      sleep 1
    done
    start_service app
    start_service web
    echo "Started POE Worksmith: http://127.0.0.1:4173/"
    ;;
  stop)
    for service in prices-on-login app web postgres; do stop_service "$service"; done
    echo "POE Worksmith stopped. Data retained."
    ;;
  status)
    for service in postgres app web; do
      if state=$(launchctl print "$domain/$prefix.$service" 2>/dev/null); then
        printf '%s: ' "$service"
        printf '%s\n' "$state" | awk '/^[[:space:]]*state = / {print $3; exit}'
      else
        echo "$service: stopped"
      fi
    done
    ;;
  *) echo "Usage: $0 start|stop|status" >&2; exit 2 ;;
esac
