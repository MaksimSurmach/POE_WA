import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(appRoot, 'dist-preview');
await build({
  root: appRoot,
  configFile: resolve(appRoot, 'vite.preview.config.ts'),
});
const cssTexts = [];
let html = await readFile(resolve(out, 'preview.html'), 'utf8');
for (const match of [
  ...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g),
]) {
  const js = await readFile(resolve(out, match[1]), 'utf8');
  const inlineJs = js.replace(/<\/script/gi, '<\\/script');
  html = html.replace(
    match[0],
    () => `<script type="module">${inlineJs}</script>`,
  );
  assert(html.includes(inlineJs), 'Preview JavaScript changed during inlining');
}
for (const match of [
  ...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g),
]) {
  const css = await readFile(resolve(out, match[1]), 'utf8');
  cssTexts.push(css);
  html = html.replace(match[0], () => `<style>${css}</style>`);
  assert(html.includes(css), 'Preview CSS changed during inlining');
}
html = html.replace(
  '<meta charset="UTF-8" />',
  "<meta charset=\"UTF-8\" /><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'\" />",
);
const markup = html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  .replace(/<style>[\s\S]*?<\/style>/g, '');
assert(
  !/<script\b[^>]*\bsrc=|<link\b[^>]*\b(?:rel="stylesheet"|rel="modulepreload")/.test(
    markup,
  ),
  'Preview still depends on external assets',
);
assert(
  !/url\((?!["']?data:)[^)]+\)/.test(cssTexts.join('\n')),
  'Preview CSS still depends on external assets',
);
await writeFile(resolve(out, 'worksmith-heroui.html'), html);
console.log(
  `Standalone preview: ${resolve(out, 'worksmith-heroui.html')} (${Buffer.byteLength(html)} bytes)`,
);
