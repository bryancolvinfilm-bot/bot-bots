import { defineConfig } from 'tsup';
export default defineConfig([
  {
    entry: {
      'server/index': 'apps/server/index.ts',
      'desktop/main': 'apps/desktop/main.ts',
      'manage-secrets': 'scripts/manage-secrets.ts',
    },
    format: ['esm'],
    outDir: 'dist',
    splitting: false,
    external: ['electron'],
    platform: 'node',
    target: 'node24',
    removeNodeProtocol: false,
    clean: false,
  },
  {
    entry: { 'desktop/preload': 'apps/desktop/preload.ts' },
    format: ['cjs'],
    outDir: 'dist',
    outExtension: () => ({ js: '.cjs' }),
    external: ['electron'],
    platform: 'node',
    target: 'node24',
    clean: false,
  },
]);
