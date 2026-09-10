import type { Configuration } from 'webpack';
import { rules } from './webpack.rules';

export const mainConfig: Configuration = {
  entry: './src/main/index.ts',
  module: { rules },
  resolve: {
    extensions: ['.js', '.ts', '.json'],
    alias: {
      '@domain': __dirname + '/src/domain',
      '@shared': __dirname + '/src/shared',
    },
  },
  externals: ['better-sqlite3', 'serialport', '@serialport/binding-mock', 'exceljs'],
  node: { __dirname: false },
};