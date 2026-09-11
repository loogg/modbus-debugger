import type { ForgeConfig } from '@electron-forge/shared-types';
import fs from 'node:fs';
import path from 'node:path';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'Modbus Debugger',
    executableName: 'modbus-debugger',
  },
  rebuildConfig: {},
  hooks: {
    packageAfterCopy: async (_config: unknown, buildPath: string) => {
      const src = path.resolve(__dirname, 'node_modules');
      const dest = path.join(buildPath, 'node_modules');
      const dirs = ['sql.js', 'bindings', 'file-uri-to-path', 'debug', 'ms', 'node-gyp-build', 'node-addon-api', 'serialport', '@serialport'];
      for (const d of dirs) {
        const from = path.join(src, d);
        if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, d), { recursive: true });
      }
    },
  },
  makers: [
    new MakerSquirrel({
      setupIcon: undefined,
      name: 'modbus-debugger',
    }),
    new MakerZIP({}, ['darwin']),
  ],
  plugins: [    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      mainConfig,
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/renderer/index.html',
            js: './src/renderer/main.tsx',
            name: 'main_window',
            preload: {
              js: './src/preload/index.ts',
            },
          },
        ],
      },
    }),
  ],
};

export default config;