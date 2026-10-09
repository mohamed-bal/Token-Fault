import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string, entry = 'index.ts'): string =>
  fileURLToPath(new URL(`./packages/${name}/src/${entry}`, import.meta.url));

/**
 * Tests run against TypeScript sources (no build step). Workspace packages are
 * aliased to their `src/` entry points. The CLI smoke test (`pnpm smoke`)
 * covers the built output separately.
 */
const alias = [
  { find: /^@tokenfault\/core\/node$/, replacement: pkg('core', 'node/index.ts') },
  { find: /^@tokenfault\/core$/, replacement: pkg('core') },
  { find: /^@tokenfault\/shared$/, replacement: pkg('shared') },
  { find: /^@tokenfault\/mock-llm$/, replacement: pkg('mock-llm') },
  { find: /^@tokenfault\/proxy$/, replacement: pkg('proxy') },
  { find: /^@tokenfault\/testing$/, replacement: pkg('testing') },
];

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
    ],
  },
});
