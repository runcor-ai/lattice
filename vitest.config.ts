import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => resolve(__dirname, 'packages', name, 'src/index.ts');

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.test.ts',
        '**/tests/fixtures/**',
      ],
    },
    reporters: ['default'],
  },
  resolve: {
    alias: {
      '@runcor/trace': pkg('trace'),
      '@runcor/capabilities': pkg('capabilities'),
      '@runcor/engine': pkg('engine'),
      '@runcor/runtime': pkg('runtime'),
      '@runcor/memory': pkg('memory'),
      '@runcor/identity': pkg('identity'),
      '@runcor/goals': pkg('goals'),
      '@runcor/drives': pkg('drives'),
      '@runcor/temporal': pkg('temporal'),
      '@runcor/decider': pkg('decider'),
      '@runcor/dialectic': pkg('dialectic'),
      '@runcor/watchdog': pkg('watchdog'),
      '@runcor/skills': pkg('skills'),
      '@runcor/jobs': pkg('jobs'),
      '@runcor/collaboration': pkg('collaboration'),
      '@runcor/snapshot': pkg('snapshot'),
      '@runcor/substrate': pkg('substrate'),
      '@runcor/slowclock': pkg('slowclock'),
      '@runcor/bridge-shared': pkg('bridge-shared'),
      '@runcor/rpp-parser': pkg('rpp-parser'),
    },
  },
});
