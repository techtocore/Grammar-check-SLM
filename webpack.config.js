import path from 'path';
import { fileURLToPath } from 'url';

import HtmlWebpackPlugin from 'html-webpack-plugin';
import CopyPlugin from 'copy-webpack-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default (_env, argv) => {
  const isProduction = argv.mode === 'production';

  return {
    mode: isProduction ? 'production' : 'development',
    // Extensions cannot use eval-based source maps under MV3 CSP.
    devtool: isProduction ? false : 'source-map',
    entry: {
      background: {
        import: './src/background/service-worker.ts',
        chunkLoading: 'import-scripts',
      },
      offscreen: './src/offscreen/offscreen.ts',
      content: './src/content/content.ts',
      popup: './src/popup/popup.ts',
      options: './src/options/options.ts',
    },
    output: {
      path: path.resolve(__dirname, 'build'),
      filename: '[name].js',
      clean: true,
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: {
            loader: 'ts-loader',
            options: { transpileOnly: true },
          },
          exclude: /node_modules/,
        },
        {
          // ONNX Runtime references its binaries via import.meta.url, which makes
          // webpack emit duplicate copies. We serve our own copies from /ort
          // (see CopyPlugin + env.backends.onnx.wasm.wasmPaths), so skip emitting.
          test: /ort-wasm.*\.wasm$/,
          type: 'asset/resource',
          generator: { emit: false },
        },
      ],
    },
    optimization: {
      // Keep deterministic, self-contained entry files (required for MV3).
      splitChunks: false,
      runtimeChunk: false,
      // Disable scope hoisting. @huggingface/transformers references the whole
      // `import.meta` object, which webpack synthesizes with an `import.meta.main`
      // check compiled to `... === __webpack_module__`. Inside a concatenated
      // (scope-hoisted) module that identifier is never declared, so the offscreen
      // script throws `__webpack_module__ is not defined` on load. Without
      // concatenation the check resolves to the real `module` argument instead.
      concatenateModules: false,
    },
    performance: {
      // The Transformers.js bundle is large by nature; don't fail the build.
      hints: false,
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: './src/popup/popup.html',
        filename: 'popup.html',
        chunks: ['popup'],
        cache: false,
      }),
      new HtmlWebpackPlugin({
        template: './src/options/options.html',
        filename: 'options.html',
        chunks: ['options'],
        cache: false,
      }),
      new HtmlWebpackPlugin({
        template: './src/offscreen/offscreen.html',
        filename: 'offscreen.html',
        chunks: ['offscreen'],
        cache: false,
      }),
      new CopyPlugin({
        patterns: [
          { from: 'public', to: '.' },
          { from: 'src/popup/popup.css', to: 'popup.css' },
          { from: 'src/options/options.css', to: 'options.css' },
          { from: 'src/content/content.css', to: 'content.css' },
          // Bundle the ONNX Runtime WebGPU/WASM binaries locally so inference works
          // under the extension CSP and offline after first model download.
          {
            from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
            to: 'ort/ort-wasm-simd-threaded.jsep.wasm',
          },
          {
            from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs',
            to: 'ort/ort-wasm-simd-threaded.jsep.mjs',
          },
          {
            from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
            to: 'ort/ort-wasm-simd-threaded.wasm',
          },
          {
            from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
            to: 'ort/ort-wasm-simd-threaded.mjs',
          },
        ],
      }),
    ],
  };
};
