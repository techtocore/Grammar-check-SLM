import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import stripTransformersNodeImportMeta from './strip-transformers-node-import-meta.cjs';
import stripOnnxBuildPath from './strip-onnx-build-path.cjs';

const transformers = await readFile(
  new URL('../node_modules/@huggingface/transformers/dist/transformers.web.js', import.meta.url),
  'utf8',
);
const onnx = await readFile(
  new URL('../node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs', import.meta.url),
  'utf8',
);

test('Transformers loader removes checkout-specific metadata from the installed release', () => {
  const output = stripTransformersNodeImportMeta(transformers);
  assert.ok(output.includes('const _import_meta_url = undefined;'));
  assert.ok(!output.includes('import.meta'));
  assert.ok(output.includes('baseURL = location.href;'));
});

test('ONNX loader removes fallback metadata but preserves bundler-resolved WASM and worker URLs', () => {
  const output = stripOnnxBuildPath(onnx);
  assert.ok(!output.includes('w=import.meta.url'));
  assert.ok(!output.includes('return import.meta.url'));
  assert.ok(!output.includes('new URL(import.meta.url)'));
  assert.ok(!output.includes('import.meta.url>"file:"'));
  assert.ok(output.includes('new URL("ort.webgpu.bundle.min.mjs",import.meta.url)'));
  assert.ok(output.includes('new URL("ort-wasm-simd-threaded.asyncify.wasm",import.meta.url)'));
});

test('build loaders fail closed when upstream expressions disappear', () => {
  for (const loader of [stripTransformersNodeImportMeta, stripOnnxBuildPath]) {
    assert.throws(() => loader('unexpected upstream source'), /Review the dependency upgrade/);
  }
});

test('build loaders fail closed when upstream expressions are duplicated', () => {
  assert.throws(
    () => stripTransformersNodeImportMeta(transformers + transformers),
    /found 2.*Review the dependency upgrade/,
  );
  assert.throws(() => stripOnnxBuildPath(onnx + onnx), /found 2.*Review the dependency upgrade/);
});
