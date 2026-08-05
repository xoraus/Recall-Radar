const path = require('path');
const fs = require('fs');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const ReactRefreshWebpackPlugin = require('@pmmmwh/react-refresh-webpack-plugin');
const { ESBuildMinifyPlugin } = require('esbuild-loader');

const isDev = process.env.NODE_ENV === 'development';

// Every .tsx file in src/widgets becomes its own bundle + HTML page, matching
// the file names passed to plugin.app.registerWidget() in src/widgets/index.tsx.
const widgetsDir = path.resolve(__dirname, 'src/widgets');
const widgetFiles = fs.readdirSync(widgetsDir).filter((f) => f.endsWith('.tsx'));

const entry = {};
const htmlPlugins = [];
for (const file of widgetFiles) {
  const name = file.replace(/\.tsx$/, '');
  entry[name] = path.join(widgetsDir, file);
  htmlPlugins.push(
    new HtmlWebpackPlugin({
      title: name,
      filename: `${name}.html`,
      chunks: [name],
      templateContent: `<!DOCTYPE html><html><head><script>
// Clean up widgetInstanceId to remove document slugs that break RemNote's parser
const url = new URL(window.location.href);
let widgetInstanceId = url.searchParams.get('widgetInstanceId');
if (widgetInstanceId) {
  // A slug is any text ending with a dash before a 14-22 char alphanumeric ID, followed by ) or _ or end of string.
  // We only match typical slug characters [a-zA-Z0-9%_-] so we don't accidentally consume the structural (( parentheses!
  // Example: ((Ledger-Accounts-JvunqYqQQmcKjKQA9)_(widget~...)_50) -> ((JvunqYqQQmcKjKQA9)_(widget~...)_50)
  const cleanId = widgetInstanceId.replace(/(?:[a-zA-Z0-9%_-]+?-)([a-zA-Z0-9]{14,22})(?=[)_]|$)/g, '$1');
  if (cleanId !== widgetInstanceId) {
    url.searchParams.set('widgetInstanceId', cleanId);
    window.history.replaceState({}, '', url);
  }
}

// Redirect logic
const params = new URLSearchParams(window.location.search);
const widgetName = params.get('widgetName');
const isIndex = window.location.pathname === '/' || window.location.pathname.endsWith('index.html');
if (widgetName && isIndex && widgetName !== 'index') {
  window.location.replace(widgetName + '.html' + window.location.search);
}
</script></head><body><div id="root"></div></body></html>`,
    })
  );
}

module.exports = {
  mode: isDev ? 'development' : 'production',
  devtool: isDev ? 'eval-source-map' : false,
  entry,
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    publicPath: '/',
    clean: true,
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: 'esbuild-loader',
        options: { loader: 'tsx', target: 'es2019' },
      },
      {
        test: /\.css$/,
        use: [isDev ? 'style-loader' : MiniCssExtractPlugin.loader, 'css-loader', 'postcss-loader'],
      },
    ],
  },
  plugins: [
    ...htmlPlugins,
    new MiniCssExtractPlugin(),
    new CopyPlugin({ patterns: [{ from: 'manifest.json' }] }),
    ...(isDev ? [new ReactRefreshWebpackPlugin()] : []),
  ],
  optimization: {
    minimizer: [new ESBuildMinifyPlugin({ target: 'es2019' })],
  },
  devServer: {
    port: 8080,
    hot: true,
    headers: { 'Access-Control-Allow-Origin': '*' },
  },
};
