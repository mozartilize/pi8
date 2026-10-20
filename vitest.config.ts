import { defineConfig } from 'vitest/config';

// Package tests live in extensions/ and eval/. Research scripts use a
// separate test configuration. Worktree copies must not share test state.
export default defineConfig({
  test: {
    include: ['extensions/**/*.test.ts', 'eval/**/*.test.ts'],
    setupFiles: ['extensions/test-support/isolate-router-dir.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
      '**/.worktrees/**',
      // The queue bench holds node:test projects that models write against; they are not router tests.
      'bench/**',
      // Elicitation fixtures are standalone node:test projects, not Vitest suites.
      'scripts/elicitation/fixtures/**',
    ],
  },
});
