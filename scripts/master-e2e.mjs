#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { assertCleanSource, validateManifest } from './master-e2e-manifest.mjs';

const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
let interrupted = false;
let cleaningUp = false;
let activeChild;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interrupted = true;
    if (!cleaningUp) activeChild?.kill(signal);
  });
}
const sha256 = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};
const failureStatus = (error) => {
  const args = error.command === 'docker' ? (error.commandArgs ?? []) : [];
  return error.command === 'docker' &&
    !['exec', 'run', 'up'].some((name) => args.includes(name))
    ? 'INFRA_BLOCKED'
    : 'FAIL';
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
  if (interrupted && !cleaningUp) throw new Error('E2E harness interrupted');
  await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: 'inherit', ...options });
    activeChild = child;
    child.on('error', (error) => {
      if (activeChild === child) activeChild = undefined;
      error.command = command;
      error.commandArgs = commandArgs;
      reject(error);
    });
    child.on('exit', (code) => {
      if (activeChild === child) activeChild = undefined;
      if (code === 0) resolve();
      else {
        const error = new Error(`${command} exited ${code}`);
        error.command = command;
        error.commandArgs = commandArgs;
        reject(error);
      }
    });
  });
}
async function capture(command, commandArgs, options = {}) {
  if (interrupted && !cleaningUp) throw new Error('E2E harness interrupted');
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: ['ignore', 'pipe', 'inherit'],
      ...options,
    });
    activeChild = child;
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.on('error', (error) => {
      if (activeChild === child) activeChild = undefined;
      error.command = command;
      error.commandArgs = commandArgs;
      reject(error);
    });
    child.on('exit', (code) => {
      if (activeChild === child) activeChild = undefined;
      if (code === 0) resolve(output.trim());
      else {
        const error = new Error(`${command} exited ${code}`);
        error.command = command;
        error.commandArgs = commandArgs;
        reject(error);
      }
    });
  });
}

function assertWorkerHeartbeat(heartbeat, after) {
  const timestamp = Date.parse(heartbeat);
  assert(Number.isFinite(timestamp), 'catalog worker heartbeat is missing');
  if (after) {
    assert(
      timestamp > Date.parse(after),
      'catalog worker did not heartbeat after restart',
    );
  } else {
    assert(
      Date.now() - timestamp < 20_000,
      'catalog worker heartbeat is stale',
    );
  }
}

async function waitForWorkerHeartbeat(compose, env, after) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const heartbeat = await capture(
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
        "select to_char(heartbeat_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') from market_worker_health where id='catalog'",
      ],
      { env },
    ).catch(() => '');
    try {
      assertWorkerHeartbeat(heartbeat, after);
      return heartbeat;
    } catch {
      if (interrupted) throw new Error('E2E harness interrupted');
      // Keep polling until the heartbeat is fresh.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assertWorkerHeartbeat('', after);
}

async function readRecipeState(compose, env) {
  return readSql(
    compose,
    env,
    "select count(*)::text || ':' || md5(coalesce(string_agg(id || ':' || content_hash, ',' order by id), '')) from recipes",
  );
}

async function readSql(compose, env, sql) {
  return capture(
    'docker',
    [
      ...compose,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-At',
      '-q',
      '-U',
      'e2e',
      '-d',
      'poe_worksmith_e2e',
      '-c',
      sql,
    ],
    { env },
  );
}

const diagnostic = (compose, env, sql) =>
  readSql(compose, env, sql).catch((error) => `unavailable: ${error.message}`);

const readMigrationState = (compose, env) =>
  readSql(
    compose,
    env,
    "select count(*)::text || ':' || md5(coalesce(string_agg(id || ':' || hash || ':' || created_at::text, ',' order by id), '')) from drizzle.__drizzle_migrations",
  );

const databaseNow = (compose, env) =>
  readSql(
    compose,
    env,
    'select to_char(now() at time zone \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\')',
  );

function collectPassedTestIds(report) {
  const ids = new Set();
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      const id = /^([A-Z]+(?:-[A-Z]+)*-\d+)\b/.exec(spec.title)?.[1];
      if (
        id &&
        spec.tests?.some((test) =>
          test.results?.some((result) => result.status === 'passed'),
        )
      ) {
        ids.add(id);
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return [...ids].sort();
}

function receipt(status, metadata, details = '') {
  const manifest = metadata.manifest;
  const value = (item) => item ?? 'unavailable';
  return [
    `${status} type=${metadata.type}`,
    `source_sha=${value(manifest?.sha)}`,
    `harness_sha=${value(metadata.harnessSha)}`,
    `build_run_id=${value(manifest?.buildRunId)}`,
    `build_attempt=${value(manifest?.buildAttempt)}`,
    `e2e_run_id=${value(metadata.e2eRunId)}`,
    `e2e_attempt=${value(metadata.e2eAttempt)}`,
    `platform=${value(manifest?.platform)}`,
    `server_image=${value(manifest?.images?.server?.imageId)}`,
    `web_image=${value(manifest?.images?.web?.imageId)}`,
    `executed_test_ids=${metadata.executedTestIds?.join(',') || 'none'}`,
    details,
  ]
    .filter(Boolean)
    .join(' ')
    .concat('\n');
}

async function selfCheck() {
  const heartbeat = new Date().toISOString();
  assertWorkerHeartbeat(heartbeat);
  assertWorkerHeartbeat(new Date(Date.now() + 1_000).toISOString(), heartbeat);
  try {
    assertWorkerHeartbeat(new Date(Date.now() - 30_000).toISOString());
    throw new Error('heartbeat check accepted a stale worker');
  } catch (error) {
    if (error.message === 'heartbeat check accepted a stale worker')
      throw error;
  }
  const testIds = collectPassedTestIds({
    suites: [
      {
        specs: [
          {
            title: 'BOOT-01 packaged route',
            tests: [{ results: [{ status: 'passed' }] }],
          },
          {
            title: 'ACL-PUBLIC-01 denied mutation',
            tests: [{ results: [{ status: 'passed' }] }],
          },
        ],
      },
    ],
  });
  assert(
    testIds.join(',') === 'ACL-PUBLIC-01,BOOT-01',
    'test receipt included an invalid ID',
  );
  assertCleanSource('artifacts/candidate', '?? artifacts/candidate/server.tar');
  try {
    assertCleanSource('artifacts/candidate', ' M scripts/master-e2e.mjs');
    throw new Error('dirty source check accepted a modified file');
  } catch (error) {
    if (error.message === 'dirty source check accepted a modified file')
      throw error;
  }
  validateOwnership(
    {
      'com.poe-worksmith.e2e.owner': 'master-e2e',
      'com.poe-worksmith.e2e.run': 'run',
      'com.poe-worksmith.e2e.attempt': '1',
    },
    { run: 'run', attempt: '1' },
  );
  const validManifest = {
    schemaVersion: 1,
    repository: 'MaksimSurmach/POE_WA',
    sha: 'a'.repeat(40),
    buildRunId: 'run',
    buildAttempt: '1',
    platform: 'linux/amd64',
    fixtures: { version: 'boot-v1', sha256: 'a'.repeat(64) },
    lockfile: { path: 'pnpm-lock.yaml', sha256: 'a'.repeat(64) },
    migrations: { path: '_journal.json', sha256: 'a'.repeat(64) },
    images: Object.fromEntries(
      ['server', 'web'].map((kind) => [
        kind,
        {
          tag: `${kind}:test`,
          imageId: `sha256:${'a'.repeat(64)}`,
          archive: `${kind}.tar`,
          archiveSha256: 'a'.repeat(64),
        },
      ]),
    ),
  };
  validateManifest(validManifest);
  for (const mutate of [
    (manifest) => (manifest.repository = 'foreign/repo'),
    (manifest) => (manifest.sha = 'bad'),
    (manifest) => (manifest.fixtures.version = 'foreign-fixture'),
    (manifest) => (manifest.images.server.archive = '../server.tar'),
  ]) {
    const invalid = structuredClone(validManifest);
    mutate(invalid);
    try {
      validateManifest(invalid);
      throw new Error('manifest check accepted invalid input');
    } catch (error) {
      if (error.message === 'manifest check accepted invalid input')
        throw error;
    }
  }
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
  const output = path.resolve('output/master-e2e');
  const verdictPath = path.join(output, 'verdict.txt');
  const composeLogPath = path.join(output, 'compose.log');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await writeFile(verdictPath, 'NOT_RUN: harness did not complete\n');
  const manifestPath = arg('--manifest');
  assert(manifestPath, 'usage: pnpm test:e2e:master -- --manifest <path>');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  validateManifest(manifest);
  await copyFile(manifestPath, path.join(output, 'manifest.json'));
  const e2eRunId = process.env.GITHUB_RUN_ID ?? `local-e2e-${process.pid}`;
  const e2eAttempt = process.env.GITHUB_RUN_ATTEMPT ?? '1';
  const metadata = {
    type: process.env.MASTER_BUILD_RUN_ID ? 'master-e2e' : 'local-candidate',
    manifest,
    harnessSha: 'unverified',
    e2eRunId,
    e2eAttempt,
    executedTestIds: [],
  };
  await writeFile(
    verdictPath,
    receipt('FAIL', metadata, 'reason=preflight-did-not-complete'),
  );
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
  if (process.env.MASTER_BUILD_RUN_ID) {
    assert(
      manifest.buildRunId === process.env.MASTER_BUILD_RUN_ID,
      'build run ID mismatch',
    );
    assert(
      manifest.buildAttempt === process.env.MASTER_BUILD_ATTEMPT,
      'build attempt mismatch',
    );
  }
  metadata.harnessSha = checkoutSha;
  const artifactRoot = path.resolve(path.dirname(manifestPath));
  assertCleanSource(
    artifactRoot,
    await capture('git', ['status', '--porcelain', '--untracked-files=all']),
  );
  await verifyChecksum('pnpm-lock.yaml', manifest.lockfile.sha256);
  await verifyChecksum(
    'apps/server/drizzle/meta/_journal.json',
    manifest.migrations.sha256,
  );
  await verifyChecksum(
    path.join(artifactRoot, manifest.lockfile.path),
    manifest.lockfile.sha256,
  );
  await verifyChecksum(
    path.join(artifactRoot, manifest.migrations.path),
    manifest.migrations.sha256,
  );
  try {
    await run('docker', ['info']);
    await run('docker', ['compose', 'version']);
  } catch (error) {
    await writeFile(
      verdictPath,
      receipt(
        interrupted ? 'FAIL' : 'INFRA_BLOCKED',
        metadata,
        `reason=${error.message}`,
      ),
    );
    throw error;
  }
  try {
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
      const platform = await capture('docker', [
        'image',
        'inspect',
        '--format',
        '{{.Os}}/{{.Architecture}}',
        image.tag,
      ]);
      assert(platform === manifest.platform, `${kind} image platform mismatch`);
    }
  } catch (error) {
    await writeFile(
      verdictPath,
      receipt(failureStatus(error), metadata, error.message),
    );
    throw error;
  }

  const runId = e2eRunId;
  const attempt = e2eAttempt;
  const e2ePort = process.env.E2E_PORT || '18080';
  const project = `mi2e0-${runId}-${attempt}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
  const env = {
    ...process.env,
    E2E_PROJECT: project,
    E2E_RUN: runId,
    E2E_ATTEMPT: attempt,
    E2E_PORT: e2ePort,
    SERVER_IMAGE: manifest.images.server.tag,
    WEB_IMAGE: manifest.images.web.tag,
  };
  const compose = ['compose', '-f', 'compose.e2e.yaml', '-p', project];
  const expectedOwner = { run: runId, attempt };
  const existing = async (commandArgs, kind) => {
    const names = (await capture('docker', commandArgs, { env }))
      .split(/\s+/)
      .filter(Boolean);
    for (const name of names) {
      const details = JSON.parse(
        await capture(
          'docker',
          kind === 'container' ? ['inspect', name] : [kind, 'inspect', name],
          { env },
        ),
      )[0];
      validateOwnership(
        details.Config?.Labels ?? details.Labels ?? {},
        expectedOwner,
      );
    }
    return names;
  };
  const existingResources = [
    ...(await existing(
      ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`],
      'container',
    )),
    ...(await existing(
      [
        'volume',
        'ls',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${project}`,
      ],
      'volume',
    )),
    ...(await existing(
      [
        'network',
        'ls',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${project}`,
      ],
      'network',
    )),
  ];
  for (const [kind, name] of [
    ['volume', `${project}_pgdata`],
    ['network', `${project}_app`],
    ['network', `${project}_browser`],
  ]) {
    const listArgs =
      kind === 'volume'
        ? ['volume', 'ls', '-q', '--filter', `name=${name}`]
        : [
            'network',
            'ls',
            '--format',
            '{{.Name}}',
            '--filter',
            `name=${name}`,
          ];
    const matches = (await capture('docker', listArgs, { env }))
      .split(/\s+/)
      .filter((resource) => resource === name);
    existingResources.push(...matches);
    for (const resource of matches) {
      const details = JSON.parse(
        await capture('docker', [kind, 'inspect', resource], { env }),
      );
      validateOwnership(details[0].Labels ?? {}, expectedOwner);
    }
  }
  assert(
    existingResources.length === 0,
    'E2E resources already exist; refusing stale state',
  );
  let passVerdict;
  let cleanupError;
  try {
    await run('docker', [...compose, 'run', '--rm', 'migrate'], { env });
    const migrationStateAfterInitialMigration = await readMigrationState(
      compose,
      env,
    );
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
    const recipeStateAfterSeed = await readRecipeState(compose, env);
    assert(
      !recipeStateAfterSeed.startsWith('0:'),
      'recipe catalog seed is empty',
    );
    await run('docker', [...compose, 'run', '--rm', 'migrate'], { env });
    const migrationStateAfterRepeatMigration = await readMigrationState(
      compose,
      env,
    );
    assert(
      migrationStateAfterRepeatMigration ===
        migrationStateAfterInitialMigration,
      'repeat migration changed the applied migration journal',
    );
    const recipeStateAfterRepeatMigration = await readRecipeState(compose, env);
    assert(
      recipeStateAfterRepeatMigration === recipeStateAfterSeed,
      'repeat migration changed the seeded recipe catalog',
    );
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
    await waitForWorkerHeartbeat(compose, env);
    const sideEffects =
      "select (select count(*) from market_admin_runs)::text || ':' || (select count(*) from market_admin_audit)::text || ':' || (select count(*) from jobs)::text || ':' || coalesce((select version::text from market_admin_settings where id=1), 'missing')";
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
        "fetch('http://web:8080/api/admin/market/pause',{method:'POST',headers:{host:'web:8080',origin:'http://web:8080','content-type':'application/json'},body:'{}'}).then(async r=>{const body=await r.json();if(r.status!==401||body.error?.code!=='OPERATOR_AUTH_REQUIRED'){console.error(JSON.stringify({status:r.status,body}));process.exit(1)}})",
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
    metadata.executedTestIds.push('ACL-PUBLIC-01');
    await run(
      'pnpm',
      ['exec', 'playwright', 'test', '-c', 'playwright.master.config.ts'],
      {
        env: {
          ...env,
          MASTER_E2E_BASE_URL: `http://127.0.0.1:${e2ePort}`,
        },
      },
    );
    const playwrightReport = JSON.parse(
      await readFile(path.join(output, 'report.json'), 'utf8'),
    );
    const passedTestIds = collectPassedTestIds(playwrightReport);
    assert(passedTestIds.includes('BOOT-01'), 'BOOT-01 did not pass');
    metadata.executedTestIds.push(...passedTestIds);
    const recipeStateBeforeRestart = await readRecipeState(compose, env);
    const sentinelId = await readSql(
      compose,
      env,
      "insert into market_admin_audit(actor,action,details) values ('master-e2e','restart-sentinel','{}'::jsonb) returning id",
    );
    await run('docker', [...compose, 'restart', 'postgres'], { env });
    await run('docker', [...compose, 'up', '-d', '--wait', 'postgres'], {
      env,
    });
    await run('docker', [...compose, 'up', '-d', '--wait', 'app', 'web'], {
      env,
    });
    await run('docker', [...compose, 'run', '--rm', 'migrate'], { env });
    assert(
      (await readMigrationState(compose, env)) ===
        migrationStateAfterRepeatMigration,
      'restart changed the applied migration journal',
    );
    await waitForWorkerHeartbeat(compose, env, await databaseNow(compose, env));
    const recipeStateAfterRestart = await readRecipeState(compose, env);
    assert(
      recipeStateAfterRestart === recipeStateBeforeRestart,
      'recipe catalog changed after database restart and repeated migration',
    );
    assert(
      (await readSql(
        compose,
        env,
        `select count(*) from market_admin_audit where id=${sentinelId} and actor='master-e2e' and action='restart-sentinel'`,
      )) === '1',
      'database restart lost the sentinel row',
    );
    await run('node', [
      '-e',
      `fetch('http://127.0.0.1:${e2ePort}/api/recipes/physical-large-cluster-jagged').then(async r=>{if(!r.ok)throw Error('web recipe route returned '+r.status);await r.json()}).catch(e=>{console.error(e);process.exit(1)})`,
    ]);
    assert(
      (await readMigrationState(compose, env)) ===
        migrationStateAfterRepeatMigration,
      'migration journal changed after restart checks',
    );
    passVerdict = receipt(
      'PASS',
      metadata,
      'checks=migrations,catalog,api,worker,acl,boot,restart',
    );
  } catch (error) {
    await writeFile(
      verdictPath,
      receipt(failureStatus(error), metadata, error.message),
    );
    throw error;
  } finally {
    cleaningUp = true;
    try {
      const [migrationJournal, queueSnapshot, lastRun] = await Promise.all([
        diagnostic(
          compose,
          env,
          'select id,hash,created_at from drizzle.__drizzle_migrations order by id',
        ),
        diagnostic(
          compose,
          env,
          'select status,count(*) from jobs group by status order by status',
        ),
        diagnostic(
          compose,
          env,
          'select id,status,requested_at,finished_at,error_code from market_admin_runs order by requested_at desc limit 1',
        ),
      ]);
      await writeFile(
        path.join(output, 'diagnostics.txt'),
        `Migration journal:\n${migrationJournal}\nQueue snapshot:\n${queueSnapshot}\nLast admin run:\n${lastRun}\n`,
      );
      const logs = await capture('docker', [...compose, 'logs', '--no-color'], {
        env,
      }).catch(() => 'Unable to retrieve compose logs.');
      await writeFile(composeLogPath, logs);
      const ids = (await capture('docker', [...compose, 'ps', '-aq'], { env }))
        .split(/\s+/)
        .filter(Boolean);
      for (const id of ids) {
        const raw = await capture('docker', ['inspect', id], { env });
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
        )
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
        )
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
      if (ids.length || volumes.length || networks.length)
        await run(
          'docker',
          [...compose, 'down', '--volumes', '--remove-orphans'],
          { env },
        );
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError) {
    await writeFile(
      verdictPath,
      receipt('FAIL', metadata, `cleanup=${cleanupError.message}`),
    );
    throw cleanupError;
  }
  if (interrupted) {
    await writeFile(
      verdictPath,
      receipt('FAIL', metadata, 'reason=interrupted'),
    );
    throw new Error('E2E harness interrupted');
  }
  await writeFile(verdictPath, passVerdict);
}
