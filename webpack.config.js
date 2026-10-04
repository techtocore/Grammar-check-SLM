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
          // Transformers.js reads import.meta.url inside a Node-only
          // branch. Webpack serializes that URL with the absolute source
          // path even in browser builds, making otherwise identical releases
          // differ by checkout directory. The loader asserts the exact upstream
          // expression before replacing its unused browser value.
          test: /@huggingface[\\/]transformers[\\/]dist[\\/]transformers\.web\.js$/,
          use: path.resolve(__dirname, 'scripts/strip-transformers-node-import-meta.cjs'),
        },
        {
          // ONNX Runtime also reads import.meta.url as generic module metadata.
          // Preserve its `new URL(..., import.meta.url)` worker/WASM expressions
          // for Webpack, but keep dead fallback metadata checkout-independent.
          test: /onnxruntime-web[\\/]dist[\\/]ort\.webgpu\.bundle\.min\.mjs$/,
          use: path.resolve(__dirname, 'scripts/strip-onnx-build-path.cjs'),
        },
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
      // Keep dependency modules isolated; prior Transformers.js builds used
      // whole import.meta metadata that broke Webpack's scope hoisting.
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
          // The locked ONNX Runtime bundle uses the asyncify pair.
          // `scripts/verify-build.mjs` rejects missing or unused runtime assets.
          {
            from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.{wasm,mjs}',
            to: 'ort/[name][ext]',
          },
          { from: 'LICENSE', to: 'LICENSE.txt' },
          { from: 'THIRD_PARTY_NOTICES.txt', to: 'THIRD_PARTY_NOTICES.txt' },
          {
            from: 'node_modules/@huggingface/transformers/LICENSE',
            to: 'licenses/APACHE-2.0.txt',
          },
          {
            from: 'node_modules/@huggingface/jinja/LICENSE',
            to: 'licenses/JINJA-MIT.txt',
          },
          {
            from: 'node_modules/platform/LICENSE',
            to: 'licenses/PLATFORM-MIT.txt',
          },
          {
            from: 'node_modules/protobufjs/LICENSE',
            to: 'licenses/PROTOBUFJS-BSD-3-CLAUSE.txt',
          },
        ],
      }),
    ],
  };
};
