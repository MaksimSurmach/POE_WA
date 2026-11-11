# Homelab collection window

The host timer keeps the collector stopped and `collectionsPaused=true` outside
14 November 2026 00:00 through 1 December 2026 00:00, Europe/Warsaw. The end is
exclusive. It reconciles every minute and after reboot; it does not depend on
Codex or a logged-in desktop.

Within the window, only the dedicated collector container starts. Configure it:

Set the collector service's Docker `restart: 'no'`. The host timer owns restarts,
including recovery during the window. This prevents Docker from starting the
collector before the timer after a reboot outside the window.

```yaml
COLLECTOR_SKIP_STANDARD: 'true'
COLLECTOR_RETENTION_ENABLED: 'false'
LEAGUE_RESOLVE_CRON: '*/15 * * * *'
LEAGUE_RESOLVE_TIMEZONE: Europe/Warsaw
```

`COLLECTOR_SKIP_STANDARD` excludes Standard and missing league evidence from
market dispatch, including manual and resumed requests. League discovery and
other maintenance jobs remain eligible. The leader immediately schedules league
discovery, then the resolver uses the configured cadence. If no temporary league
exists, the process can discover leagues but does not collect Standard prices.

Retention is disabled for this bounded collection window so that new snapshots
remain available for later analysis. On 1 December the collector stops; the host
timer remains active to enforce the stop. No historical cleanup runs on startup.

Install the files as root:

```sh
install -d -m 755 /opt/worksmith/collection-window
install -m 644 collection-window.py /opt/worksmith/collection-window/
install -d -m 700 /etc/worksmith
install -m 600 collection-window.env /etc/worksmith/collection-window.env
install -m 644 worksmith-collection-window.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now worksmith-collection-window.timer
systemctl start worksmith-collection-window.service
```

The controller refuses to resume a container without the Standard guard flag or
with an autonomous Docker restart policy. An
API/configuration failure stops the collector and leaves a failed systemd unit
for inspection; the timer retries on the next minute. API settings are changed
only when the pause value differs, so an idle timer does not grow the audit log.
Deployment or manual pause changes during the window are reconciled by the timer.
For an intentional override, disable the timer first.

Check with `systemctl status worksmith-collection-window.timer` and
`journalctl -u worksmith-collection-window.service`. Tests:
`python3 -B -m unittest discover -s deploy/homelab -p 'test_*.py'`.
