import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    action: 'src/action-entry.ts',
  },
  format: ['cjs'],
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: false,
  target: 'node20',
  platform: 'node',
  outDir: 'action/dist',
  noExternal: [/.*/],
  outExtension() {
    return { js: '.cjs' };
  },
});
