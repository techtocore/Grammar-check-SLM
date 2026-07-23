import { access, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, 'build');
const maxBuildBytes = 50 * 1024 * 1024;
const runtimePattern = /ort-wasm-simd-threaded(?:\.(?:asyncify|jsep|jspi))?\.(?:mjs|wasm)/g;
const localPathPattern = /file:\/\/\/[A-Za-z]:\/|file:\/\/\/(?:Users|home)\//;
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(buildDir, 'manifest.json'), 'utf8'));

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(absolute)));
    else files.push(absolute);
  }
  return files;
}

function manifestPaths(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).filter((entry) => typeof entry === 'string');
}

const manifestFiles = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_page,
  ...manifestPaths(manifest.action?.default_icon),
  ...manifestPaths(manifest.icons),
  ...(manifest.content_scripts ?? []).flatMap((entry) => [
    ...(entry.js ?? []),
    ...(entry.css ?? []),
  ]),
].filter((value) => typeof value === 'string');

const requiredFiles = new Set([
  'manifest.json',
  'offscreen.js',
  'offscreen.html',
  'popup.css',
  'options.css',
  'LICENSE.txt',
  'THIRD_PARTY_NOTICES.txt',
  'licenses/APACHE-2.0.txt',
  'licenses/JINJA-MIT.txt',
  'licenses/PLATFORM-MIT.txt',
  'licenses/PROTOBUFJS-BSD-3-CLAUSE.txt',
  ...manifestFiles,
]);

for (const relative of requiredFiles) {
  const target = path.join(buildDir, relative);
  await access(target);
  if (!(await stat(target)).isFile()) {
    throw new Error(`Required build artifact is not a file: ${relative}`);
  }
}

if (manifest.version !== packageJson.version) {
  throw new Error(
    `Package version ${packageJson.version} does not match manifest version ${manifest.version}.`,
  );
}

const extensionCsp = manifest.content_security_policy?.extension_pages ?? '';
if (
  !extensionCsp.includes("'wasm-unsafe-eval'") ||
  /(?:^|\s)'unsafe-eval'(?:\s|;|$)/.test(extensionCsp) ||
  !/(?:^|;)\s*object-src\s+'none'(?:\s|;|$)/.test(extensionCsp)
) {
  throw new Error(
    'Extension CSP must allow local WASM, block plugins, and forbid JavaScript eval.',
  );
}

const files = await filesUnder(buildDir);
const sourceMaps = files.filter((file) => file.endsWith('.map'));
if (sourceMaps.length > 0) {
  throw new Error(
    `Production build contains source maps: ${sourceMaps
      .map((file) => path.relative(buildDir, file))
      .join(', ')}`,
  );
}

for (const file of files.filter((candidate) => candidate.endsWith('.html'))) {
  const source = await readFile(file, 'utf8');
  if (/<script\b[^>]*\bsrc\s*=\s*["']https?:/i.test(source)) {
    throw new Error(`Extension page loads a remote script: ${path.relative(buildDir, file)}`);
  }
}

const referencedRuntimes = new Set();
for (const file of files.filter((candidate) => /\.(?:js|mjs)$/.test(candidate))) {
  const source = await readFile(file, 'utf8');
  if (localPathPattern.test(source)) {
    throw new Error(`Build contains an absolute local file URL: ${path.relative(buildDir, file)}`);
  }
  const forbiddenNodeModule =
    /onnxruntime-node|adm-zip|(?:require|import)\s*\(\s*["']sharp["']\s*\)|\bfrom\s*["']sharp["']/;
  if (forbiddenNodeModule.test(source)) {
    throw new Error(
      `Production code contains a Node-only dependency: ${path.relative(buildDir, file)}`,
    );
  }
  for (const match of source.matchAll(runtimePattern)) referencedRuntimes.add(match[0]);
}

if (referencedRuntimes.size === 0) {
  throw new Error('No ONNX Runtime assets were referenced by the production bundle.');
}

for (const runtime of referencedRuntimes) {
  await access(path.join(buildDir, 'ort', runtime)).catch(() => {
    throw new Error(`Production code references missing ONNX Runtime asset: ${runtime}`);
  });
}

const packagedRuntimes = await readdir(path.join(buildDir, 'ort'));
const unreferencedRuntimes = packagedRuntimes.filter((name) => !referencedRuntimes.has(name));
if (unreferencedRuntimes.length > 0) {
  throw new Error(
    `Unreferenced ONNX Runtime assets were packaged: ${unreferencedRuntimes.join(', ')}`,
  );
}

let buildBytes = 0;
for (const file of files) buildBytes += (await stat(file)).size;
if (buildBytes > maxBuildBytes) {
  throw new Error(
    `Production build is ${(buildBytes / 1024 / 1024).toFixed(2)} MiB; limit is ${(
      maxBuildBytes /
      1024 /
      1024
    ).toFixed(0)} MiB.`,
  );
}

console.log(
  `Verified ${referencedRuntimes.size} ONNX Runtime assets; build size ${(
    buildBytes /
    1024 /
    1024
  ).toFixed(2)} MiB.`,
);
