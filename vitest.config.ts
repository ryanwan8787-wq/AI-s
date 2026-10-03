import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    typecheck: {
      enabled: true,
      include: ['tests/**/*.test-d.ts'],
      tsconfig: './tsconfig.node.json',
    },
    coverage: {
      provider: 'v8',
      include: ['src/shared/**/*.ts'],
      exclude: ['src/shared/providers/**', 'src/shared/index.ts'],
    },
  },
});
