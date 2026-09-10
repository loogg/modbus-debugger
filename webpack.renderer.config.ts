import type { Configuration } from 'webpack';
import { rules } from './webpack.rules';

export const rendererConfig: Configuration = {
  module: {
    rules: [
      ...rules,
      {
        test: /\.css$/,
        use: [
          { loader: 'style-loader' },
          { loader: 'css-loader' },
          {
            loader: 'postcss-loader',
            options: { postcssOptions: { config: __dirname + '/postcss.config.js' } },
          },
        ],
      },
    ],
  },
  resolve: {
    extensions: ['.js', '.ts', '.tsx', '.json'],
    alias: {
      '@domain': __dirname + '/src/domain',
      '@shared': __dirname + '/src/shared',
      '@renderer': __dirname + '/src/renderer',
    },
  },
};