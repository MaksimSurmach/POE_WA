#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const sha256 = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');

const isSha256 = (value) => /^[0-9a-f]{64}$/.test(value ?? '');
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};

export function assertCleanSource(artifactRoot, status) {
  const artifactPath = `${path.relative(process.cwd(), artifactRoot)}/`;
  // Dockerfile copies selected runtime paths, so plan documents and artifacts do not enter images.
  const dirty = status
    .split('\n')
    .filter(Boolean)
    .filter((line) => {
      const file = line.slice(3);
      return ![
        artifactPath,
        'artifacts/',
        'docs/plans/2026-11-04-market-intelligence-2/',
      ].some((path) => file.startsWith(path));
    });
  assert(dirty.length === 0, `dirty source worktree: ${dirty.join(', ')}`);
}

function safeArtifactPath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/).includes('..')
  );
}

export function validateManifest(manifest) {
  assert(manifest?.schemaVersion === 1, 'unsupported manifest schema');
  assert(
    manifest.repository === 'MaksimSurmach/POE_WA',
    'manifest repository mismatch',
  );
  assert(/^[0-9a-f]{40}$/.test(manifest.sha ?? ''), 'invalid source SHA');
  assert(manifest.platform === 'linux/amd64', 'E0 accepts linux/amd64 only');
  assert(manifest.buildRunId?.length > 0, 'missing build run ID');
  assert(manifest.buildAttempt?.length > 0, 'missing build attempt');
  assert(
    manifest.fixtures?.version === 'boot-v1' &&
      isSha256(manifest.fixtures.sha256),
    'fixture identity mismatch',
  );
  for (const record of [manifest.lockfile, manifest.migrations]) {
    assert(
      safeArtifactPath(record?.path),
      'manifest path escapes artifact directory',
    );
    assert(isSha256(record?.sha256), 'invalid manifest file checksum');
  }
  for (const kind of ['server', 'web']) {
    const image = manifest.images?.[kind];
    assert(image?.tag?.length > 0, `missing ${kind} image tag`);
    assert(
      /^sha256:[0-9a-f]{64}$/.test(image?.imageId ?? ''),
      `invalid ${kind} image ID`,
    );
    assert(
      safeArtifactPath(image?.archive),
      'manifest path escapes artifact directory',
    );
    assert(isSha256(image?.archiveSha256), `invalid ${kind} archive checksum`);
  }
}

export async function createMasterE2EManifest(outputPath) {
  const artifactRoot = path.dirname(outputPath);
  assertCleanSource(
    artifactRoot,
    execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      encoding: 'utf8',
    }),
  );
  const sha =
    process.env.GITHUB_SHA ??
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const imageTag = process.env.IMAGE_TAG ?? `local/poe-worksmith:${sha}`;
  await mkdir(artifactRoot, { recursive: true });
  await copyFile('pnpm-lock.yaml', path.join(artifactRoot, 'pnpm-lock.yaml'));
  await copyFile(
    'apps/server/drizzle/meta/_journal.json',
    path.join(artifactRoot, '_journal.json'),
  );

  const image = (kind) => {
    const tag = `${imageTag}-${kind}`;
    return {
      tag,
      imageId: execFileSync(
        'docker',
        ['image', 'inspect', '--format', '{{.Id}}', tag],
        { encoding: 'utf8' },
      ).trim(),
      archive: `${kind}.tar`,
    };
  };
  const [server, web] = await Promise.all([image('server'), image('web')]);
  const fixtures = createHash('sha256')
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
  const manifest = {
    schemaVersion: 1,
    repository: process.env.GITHUB_REPOSITORY ?? 'MaksimSurmach/POE_WA',
    sha,
    buildRunId:
      process.env.GITHUB_RUN_ID ?? `local-candidate-${sha.slice(0, 7)}`,
    buildAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '1',
    platform: 'linux/amd64',
    fixtures: { version: 'boot-v1', sha256: fixtures },
    lockfile: {
      path: 'pnpm-lock.yaml',
      sha256: await sha256(path.join(artifactRoot, 'pnpm-lock.yaml')),
    },
    migrations: {
      path: '_journal.json',
      sha256: await sha256(path.join(artifactRoot, '_journal.json')),
    },
    images: { server, web },
  };
  for (const kind of ['server', 'web']) {
    manifest.images[kind].archiveSha256 = await sha256(
      path.join(artifactRoot, manifest.images[kind].archive),
    );
  }
  validateManifest(manifest);
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

const scriptPath = process.argv[1] && path.resolve(process.argv[1]);
if (scriptPath === fileURLToPath(import.meta.url)) {
  await createMasterE2EManifest(
    path.resolve(process.argv[2] ?? 'artifacts/manifest.json'),
  );
}
