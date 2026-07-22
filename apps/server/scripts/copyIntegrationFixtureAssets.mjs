import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const server = dirname(dirname(fileURLToPath(import.meta.url)));
const syntheticSource = join(server, 'src/testkit/recipes');
const assets = join(server, 'dist/testkit/recipe-assets');
const syntheticDestination = join(assets, 'synthetic');
const productionSource = join(
  server,
  '../../recipes/physical-large-cluster/recipe.md',
);
const productionDestination = join(
  assets,
  'production/physical-large-cluster/recipe.md',
);

const files = (await readdir(syntheticSource)).filter((file) =>
  file.endsWith('.md'),
);
if (files.length !== 19)
  throw new Error(`Expected 19 synthetic recipes, found ${files.length}`);
await stat(productionSource);
await rm(assets, { force: true, recursive: true });
await mkdir(syntheticDestination, { recursive: true });
await cp(syntheticSource, syntheticDestination, { recursive: true });
await mkdir(dirname(productionDestination), { recursive: true });
await cp(productionSource, productionDestination);
