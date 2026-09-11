import { defineConfig } from 'vite';
import path from 'node:path';

// Native modules stay external: they are copied into the package by the forge
// packageAfterCopy hook and loaded at runtime from node_modules.
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['sql.js', 'serialport', '@serialport/bindings-cpp', '@serialport/stream', '@serialport/binding-mock'],
    },
  },
  resolve: {
    alias: {
      '@domain': path.resolve(__dirname, 'src/domain'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
});