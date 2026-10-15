import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  target: 'es2022',
  platform: 'browser',
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Both stay external: `vue` is a peer dependency and must be the host
  // application's copy, and the core package is the SDK itself.
  external: ['vue', '@hayrat/hesabim-core'],
});
