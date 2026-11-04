# Native macOS runtime

The native installation lives in `~/Library/Application Support/POE Worksmith`.
It contains its own Node binary, compiled release, PostgreSQL database, logs,
and backups. Closing a browser or a Codex chat does not stop server processes.

The old installation put four jobs in `~/Library/LaunchAgents` with
`RunAtLoad`; the app, web, and database also used `KeepAlive`. That made the
application start at login and restart after termination.

The manual installation keeps these plist files in the runtime's
`launchagents/` directory, outside macOS login discovery, with `KeepAlive`
disabled. No database or price history is removed. The old login refresh job
is retained as an inactive file and is not part of manual startup.

From this checkout:

```sh
pnpm local:start
pnpm local:status
pnpm local:stop
```

The installed `Start POE Worksmith.command` and `Stop POE Worksmith.command`
files perform the same operations from Finder, without depending on a checkout.
Startup waits for PostgreSQL before starting the API and web. Stop unloads the
jobs, waits for each process to exit, and stops PostgreSQL last. Repeating start
or stop is safe. A failed shutdown leaves dependent services running and reports
the failure rather than killing them.

After starting, open <http://127.0.0.1:4173/>. Market administration remains at
<http://127.0.0.1:4173/admin/market>. Collection schedules apply only while the
app is running. Prices can expire while it is stopped; start it and allow a
refresh before relying on the estimates.

The control script manages an existing installation; it is not an installer.
It expects the native PostgreSQL 17 installation and loopback port 54326.
Logs and rollback releases remain in the runtime directory. Do not use
`pnpm db:reset` to manage this installation.
