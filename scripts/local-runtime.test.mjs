import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('native service control is ordered, idempotent, and reports launch failures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'poe-runtime-control-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'curl'),
    '#!/bin/sh\n[ "${TEST_HTTP_FAIL:-}" != "yes" ]\n',
    { mode: 0o755 },
  );
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(
    join(bin, 'launchctl'),
    `#!/bin/sh
set -eu
label="\${3:-$2}"
label="\${label##*/}"
label="\${label%.plist}"
file="$TEST_STATE/$label"
case "$1" in
print) [ -f "$file" ] || exit 1; echo 'state = running' ;;
bootstrap) [ "\${TEST_FAIL:-}" != "$label" ] || exit 5; touch "$file"; echo "$label start" >> "$TEST_STATE/events" ;;
kickstart) [ -f "$file" ] ;;
bootout) rm "$file"; echo "$label stop" >> "$TEST_STATE/events" ;;
esac
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    PG_ISREADY: '/usr/bin/true',
    TEST_STATE: dir,
  };
  const run = (action, extra = {}) =>
    spawnSync(
      '/bin/sh',
      [fileURLToPath(new URL('./local-runtime.sh', import.meta.url)), action],
      { env: { ...env, ...extra }, encoding: 'utf8' },
    );
  try {
    assert.equal(run('invalid').status, 2);
    assert.match(run('status').stdout, /app: stopped/);
    const unavailable = run('start', { TEST_HTTP_FAIL: 'yes' });
    assert.equal(unavailable.status, 1);
    assert.match(unavailable.stderr, /is not ready/);
    assert.doesNotMatch(unavailable.stdout, /Started POE Worksmith/);
    assert.equal(run('start').status, 0);
    assert.equal(run('start').status, 0);
    assert.match(run('status').stdout, /app: running/);
    assert.equal(run('stop').status, 0);
    assert.equal(run('stop').status, 0);
    assert.deepEqual(
      readFileSync(join(dir, 'events'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.replace('com.maksimsurmach.poe-worksmith.', '')),
      [
        'postgres start',
        'app start',
        'web start',
        'app stop',
        'web stop',
        'postgres stop',
      ],
    );
    assert.equal(
      run('start', { TEST_FAIL: 'com.maksimsurmach.poe-worksmith.postgres' })
        .status,
      5,
    );
    assert.match(run('status').stdout, /app: stopped/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
