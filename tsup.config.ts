import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    main: 'electron/main.ts',
    preload: 'electron/preload.ts',
  },
  outDir: 'dist/electron',
  format: ['cjs'],
  target: 'node18',
  platform: 'node',
  sourcemap: true,
  splitting: false,
  clean: false,
  shims: false,
  bundle: true,
  dts: false,
  external: ['electron', 'sqlite3'],
  env: {
    NODE_ENV: process.env.NODE_ENV ?? 'development',
  },
});
