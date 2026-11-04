#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const sha256 = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};
export async function verifyChecksum(file, expected) {
  assert((await sha256(file)) === expected, 'artifact checksum mismatch');
}

export function validateOwnership(labels, expected) {
  assert(
    labels['com.poe-worksmith.e2e.owner'] === 'master-e2e',
    'foreign resource owner',
  );
  assert(
    labels['com.poe-worksmith.e2e.run'] === expected.run,
    'foreign run label',
  );
  assert(
    labels['com.poe-worksmith.e2e.attempt'] === expected.attempt,
    'foreign attempt label',
  );
}

async function run(command, commandArgs, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
async function capture(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: ['ignore', 'pipe', 'inherit'],
      ...options,
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

async function selfCheck() {
  validateOwnership(
    {
      'com.poe-worksmith.e2e.owner': 'master-e2e',
      'com.poe-worksmith.e2e.run': 'run',
      'com.poe-worksmith.e2e.attempt': '1',
    },
    { run: 'run', attempt: '1' },
  );
  for (const bad of [
    { run: 'other', attempt: '1' },
    { run: 'run', attempt: '2' },
    { run: 'run', attempt: '1', owner: 'other' },
  ]) {
    try {
      validateOwnership(
        {
          'com.poe-worksmith.e2e.owner': bad.owner ?? 'master-e2e',
          'com.poe-worksmith.e2e.run': bad.run,
          'com.poe-worksmith.e2e.attempt': bad.attempt,
        },
        { run: 'run', attempt: '1' },
      );
      throw new Error('ownership check accepted foreign resource');
    } catch (error) {
      if (error.message === 'ownership check accepted foreign resource')
        throw error;
    }
  }
  const temp = await mkdtemp(
    path.join(process.env.TMPDIR ?? '/tmp', 'mi2-e0-'),
  );
  try {
    const file = path.join(temp, 'artifact');
    await writeFile(file, 'verified');
    await verifyChecksum(
      file,
      createHash('sha256').update('verified').digest('hex'),
    );
    try {
      await verifyChecksum(file, '0'.repeat(64));
      throw new Error('checksum check accepted modified artifact');
    } catch (error) {
      if (error.message === 'checksum check accepted modified artifact')
        throw error;
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  process.stdout.write('master-e2e self-check PASS\n');
}

if (args.includes('--self-check')) await selfCheck();
else {
  const manifestPath = arg('--manifest');
  assert(manifestPath, 'usage: pnpm test:e2e:master -- --manifest <path>');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert(manifest.schemaVersion === 1, 'unsupported manifest schema');
  assert(
    manifest.repository === 'MaksimSurmach/POE_WA',
    'manifest repository mismatch',
  );
  assert(/^[0-9a-f]{40}$/.test(manifest.sha), 'invalid source SHA');
  assert(manifest.platform === 'linux/amd64', 'E0 accepts linux/amd64 only');
  assert(manifest.fixtures?.version === 'boot-v1', 'fixture identity mismatch');
  const fixtureHash = createHash('sha256')
    .update(
      Buffer.concat(
        await Promise.all(
          [
            'tests/e2e/fixtures.ts',
            'tests/e2e/boot.spec.ts',
            'compose.e2e.yaml',
          ].map((file) => readFile(file)),
        ),
      ),
    )
    .digest('hex');
  assert(fixtureHash === manifest.fixtures.sha256, 'fixture checksum mismatch');
  const checkoutSha = await capture('git', ['rev-parse', 'HEAD']);
  assert(
    checkoutSha === manifest.sha,
    'harness checkout does not match built image SHA',
  );
  if (process.env.GITHUB_RUN_ID) {
    assert(
      manifest.buildRunId === process.env.GITHUB_RUN_ID,
      'build run ID mismatch',
    );
    assert(
      manifest.buildAttempt === process.env.GITHUB_RUN_ATTEMPT,
      'build attempt mismatch',
    );
  }
  const artifactRoot = path.resolve(path.dirname(manifestPath));
  for (const file of [
    manifest.lockfile.path,
    manifest.migrations.path,
    ...['server', 'web'].map((key) => manifest.images[key].archive),
  ]) {
    assert(
      !path.isAbsolute(file) && !file.split(/[\\/]/).includes('..'),
      'manifest path escapes artifact directory',
    );
  }
  await verifyChecksum(
    path.join(artifactRoot, manifest.lockfile.path),
    manifest.lockfile.sha256,
  );
  await verifyChecksum(
    path.join(artifactRoot, manifest.migrations.path),
    manifest.migrations.sha256,
  );
  for (const kind of ['server', 'web']) {
    const image = manifest.images[kind];
    const archive = path.join(artifactRoot, image.archive);
    await verifyChecksum(archive, image.archiveSha256);
    await run('docker', ['load', '--input', archive]);
    const imageId = await capture('docker', [
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      image.tag,
    ]);
    assert(imageId === image.imageId, `${kind} image ID mismatch`);
  }

  const runId = process.env.GITHUB_RUN_ID ?? `local-${process.pid}`;
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? '1';
  const project = `mi2e0-${runId}-${attempt}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
  const env = {
    ...process.env,
    E2E_PROJECT: project,
    E2E_RUN: runId,
    E2E_ATTEMPT: attempt,
    SERVER_IMAGE: manifest.images.server.tag,
    WEB_IMAGE: manifest.images.web.tag,
  };
  const compose = ['compose', '-f', 'compose.e2e.yaml', '-p', project];
  const output = path.resolve('output/master-e2e');
  await mkdir(output, { recursive: true });
  const expectedOwner = { run: runId, attempt };
  const existing = async (commandArgs) => {
    const names = (
      await capture('docker', commandArgs, { env }).catch(() => '')
    )
      .split(/\s+/)
      .filter(Boolean);
    for (const name of names) {
      const details = JSON.parse(
        await capture('docker', ['inspect', name], { env }),
      )[0];
      validateOwnership(
        details.Config?.Labels ?? details.Labels ?? {},
        expectedOwner,
      );
    }
  };
  await existing([
    'ps',
    '-aq',
    '--filter',
    `label=com.docker.compose.project=${project}`,
  ]);
  await existing([
    'volume',
    'ls',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${project}`,
  ]);
  await existing([
    'network',
    'ls',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${project}`,
  ]);
  for (const [kind, name] of [
    ['volume', `${project}_pgdata`],
    ['network', `${project}_app`],
  ]) {
    const matches = (
      await capture(
        'docker',
        [kind, 'ls', '-q', '--filter', `name=^${name}$`],
        {
          env,
        },
      ).catch(() => '')
    )
      .split(/\s+/)
      .filter(Boolean);
    for (const resource of matches) {
      const details = JSON.parse(
        await capture('docker', [kind, 'inspect', resource], { env }),
      )[0];
      validateOwnership(
        details.Config?.Labels ?? details.Labels ?? {},
        expectedOwner,
      );
    }
  }
  try {
    await run('docker', [...compose, 'run', '--rm', 'migrate'], { env });
    await run(
      'docker',
      [
        ...compose,
        'run',
        '--rm',
        'migrate',
        'node',
        'dist/recipes/syncCatalog.js',
        '/app/recipes',
      ],
      { env },
    );
    await run('docker', [...compose, 'run', '--rm', 'migrate'], { env });
    await run('docker', [...compose, 'up', '-d', '--wait', 'app', 'web'], {
      env,
    });
    await run(
      'docker',
      [
        ...compose,
        'exec',
        '-T',
        'app',
        'node',
        '-e',
        "fetch('http://127.0.0.1:3000/health/ready').then(r=>{if(!r.ok)process.exit(1)})",
      ],
      { env },
    );
    await run(
      'docker',
      [
        ...compose,
        'exec',
        '-T',
        'app',
        'node',
        '-e',
        "Promise.all(['/api/catalog','/api/recipes/physical-large-cluster-jagged'].map(async p=>{const r=await fetch('http://127.0.0.1:3000'+p);if(!r.ok)throw Error(p+' returned '+r.status);await r.json()})).catch(e=>{console.error(e);process.exit(1)})",
      ],
      { env },
    );
    await run(
      'docker',
      [
        ...compose,
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'e2e',
        '-d',
        'poe_worksmith_e2e',
        '-c',
        "select 1 from market_worker_health where id='catalog' and heartbeat_at > now() - interval '30 seconds'",
      ],
      { env },
    );
    const sideEffects =
      "select (select count(*) from market_admin_runs)::text || ':' || (select count(*) from market_admin_audit)::text || ':' || (select count(*) from jobs)::text";
    const beforeDeniedMutation = await capture(
      'docker',
      [
        ...compose,
        'exec',
        '-T',
        'postgres',
        'psql',
        '-At',
        '-U',
        'e2e',
        '-d',
        'poe_worksmith_e2e',
        '-c',
        sideEffects,
      ],
      { env },
    );
    await run(
      'docker',
      [
        ...compose,
        'run',
        '--rm',
        'migrate',
        'node',
        '-e',
        "fetch('http://app:3000/api/admin/market/pause',{method:'POST',headers:{host:'app:3000',origin:'http://app:3000','content-type':'application/json'},body:'{}'}).then(async r=>{if(r.status!==403){console.error(await r.text());process.exit(1)}})",
      ],
      { env },
    );
    const afterDeniedMutation = await capture(
      'docker',
      [
        ...compose,
        'exec',
        '-T',
        'postgres',
        'psql',
        '-At',
        '-U',
        'e2e',
        '-d',
        'poe_worksmith_e2e',
        '-c',
        sideEffects,
      ],
      { env },
    );
    assert(
      beforeDeniedMutation === afterDeniedMutation,
      'public admin denial created side effects',
    );
    await run(
      'pnpm',
      ['exec', 'playwright', 'test', '-c', 'playwright.master.config.ts'],
      { env: { ...env, MASTER_E2E_BASE_URL: 'http://127.0.0.1:18080' } },
    );
    await writeFile(
      path.join(output, 'verdict.txt'),
      `PASS candidate=${manifest.sha} server=${manifest.images.server.imageId} web=${manifest.images.web.imageId}\n`,
    );
  } catch (error) {
    await run('docker', [...compose, 'logs', '--no-color'], { env }).catch(
      () => {},
    );
    await writeFile(
      path.join(output, 'verdict.txt'),
      `FAIL candidate=${manifest.sha}\n${error.stack ?? error}\n`,
    );
    throw error;
  } finally {
    const ids = (
      await capture('docker', [...compose, 'ps', '-aq'], { env }).catch(
        () => '',
      )
    )
      .split(/\s+/)
      .filter(Boolean);
    for (const id of ids) {
      const raw = await new Promise((resolve, reject) => {
        const child = spawn('docker', ['inspect', id], {
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        let data = '';
        child.stdout.on('data', (chunk) => (data += chunk));
        child.on('exit', (code) =>
          code === 0 ? resolve(data) : reject(new Error('inspect failed')),
        );
      });
      const labels = JSON.parse(raw)[0].Config.Labels ?? {};
      validateOwnership(labels, expectedOwner);
    }
    const volumes = (
      await capture(
        'docker',
        [
          'volume',
          'ls',
          '-q',
          '--filter',
          `label=com.docker.compose.project=${project}`,
        ],
        { env },
      ).catch(() => '')
    )
      .split(/\s+/)
      .filter(Boolean);
    for (const volume of volumes) {
      const raw = await capture(
        'docker',
        ['volume', 'inspect', volume, '--format', '{{json .Labels}}'],
        { env },
      );
      validateOwnership(JSON.parse(raw), { run: runId, attempt });
    }
    const networks = (
      await capture(
        'docker',
        [
          'network',
          'ls',
          '-q',
          '--filter',
          `label=com.docker.compose.project=${project}`,
        ],
        { env },
      ).catch(() => '')
    )
      .split(/\s+/)
      .filter(Boolean);
    for (const network of networks) {
      const raw = await capture(
        'docker',
        ['network', 'inspect', network, '--format', '{{json .Labels}}'],
        { env },
      );
      validateOwnership(JSON.parse(raw), expectedOwner);
    }
    if (ids.length || volumes.length)
      await run(
        'docker',
        [...compose, 'down', '--volumes', '--remove-orphans'],
        { env },
      );
  }
}
