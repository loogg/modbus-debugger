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
      const dirs = ['better-sqlite3', 'bindings', 'file-uri-to-path', 'debug', 'ms', 'node-gyp-build', 'node-addon-api', 'serialport', '@serialport'];
      for (const d of dirs) {
        const from = path.join(src, d);
        if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, d), { recursive: true });
      }
      // better-sqlite3 is ABI-specific: always ship the Electron build regardless of the
      // current node_modules state (which may hold Node-ABI binaries for the test run).
      const stash = path.resolve(__dirname, 'tools', 'natives-electron', 'better_sqlite3.node');
      if (fs.existsSync(stash)) {
        const target = path.join(dest, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(stash, target);
      }
    },
    // Native modules (better-sqlite3, serialport) must be rebuilt for the Electron ABI.
    postPackage: async (_config, options) => {
      void options;
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