import type { ForgeConfig } from '@electron-forge/shared-types';
import fs from 'node:fs';
import path from 'node:path';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { assembleRelease } from './tools/release';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'Modbus Debugger',
    executableName: 'modbus-debugger',
    icon: path.resolve(__dirname, 'build', 'icon.ico'),
    extraResource: [path.resolve(__dirname, 'build', 'icon.png')],
  },
  rebuildConfig: {},
  hooks: {
    postMake: async (_config, results) => {
      await assembleRelease(__dirname, results);
      return results;
    },
    packageAfterCopy: async (_config: unknown, buildPath: string) => {
      // The Vite plugin makes the packager skip node_modules, so every dependency that the
      // bundled main process still loads through a runtime require() (native/UMD modules kept
      // external in vite.main.config.ts) has to be copied into the package explicitly.
      const src = path.resolve(__dirname, 'node_modules');
      const dest = path.join(buildPath, 'node_modules');
      const dirs = ['sql.js', 'serialport', '@serialport', 'debug', 'ms', 'node-gyp-build', 'node-addon-api'];
      for (const d of dirs) {
        const from = path.join(src, d);
        if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, d), { recursive: true });
      }
    },
  },
  makers: [
    new MakerSquirrel({
      setupIcon: path.resolve(__dirname, 'build', 'icon.ico'),
      name: 'modbus-debugger',
    }),
    new MakerZIP({}, ['darwin', 'win32']),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // main + preload are bundled to CJS into .vite/build; the renderer is built from the
      // root index.html into .vite/renderer/main_window and served over the app:// scheme.
      build: [
        { entry: 'src/main/index.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
  ],
};

export default config;
