const path = require('path');

module.exports = {
  entry: {
    // Vendor bundle: Streamr SDK + Ethers.js
    vendor: './src/streamr-bundle.js',
    // App bundle: All application modules
    app: './src/js/app.js',
  },
  output: {
    filename: 'js/[name].bundle.js',
    path: path.resolve(__dirname),
    library: {
      name: '[name]Bundle',
      type: 'umd',
    },
    globalObject: 'this',
  },
  resolve: {
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
    }
  },
  performance: {
    hints: false,
    maxEntrypointSize: 2048000,
    maxAssetSize: 2048000
  }
};
