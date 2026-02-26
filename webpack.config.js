const path = require('path');

module.exports = {
  entry: {
    // Vendor bundle: Streamr SDK + Ethers.js
    vendor: './src/streamr-bundle.js',
    // App bundle: All application modules
    app: './src/js/app.js',
    // Crypto Worker bundle: Offloads heavy crypto operations
    'crypto.worker': './src/js/workers/cryptoWorker.js',
  },
  output: {
    filename: 'js/[name].bundle.js',
    path: path.resolve(__dirname),
    library: {
      name: '[name]Bundle',
      type: 'umd',
    },
    globalObject: 'self', // Important for worker compatibility
  },
  resolve: {
    // Use browser exports from packages (important for @streamr/sdk)
    mainFields: ['browser', 'module', 'main'],
    conditionNames: ['browser', 'import', 'default'],
    fallback: {
      "crypto": false,
      "stream": false,
      "buffer": false,
      "util": false,
      "assert": false,
      "http": false,
      "https": false,
      "os": false,
      "url": false,
      "zlib": false,
      // Disable timers-browserify polyfill (uses inline script that violates CSP)
      "timers": false,
      "setimmediate": false,
    },
    alias: {
      // Force use of native browser timers instead of polyfill
      'timers-browserify': false,
      'setimmediate': false,
    }
  },
  performance: {
    hints: false,
    maxEntrypointSize: 2048000,
    maxAssetSize: 2048000
  }
};
