import { defineConfig } from 'vitest/config';

// Default Vitest include/exclude, plus exclusion of git worktree copies.
// Without the `.worktrees` entry, every `.worktrees/**` test file runs a
// second time (doubling the suite) and the duplicated copies race each
// other on shared resources — the `.gitignore` entry alone is not enough,
// since Vitest does not consult it for test discovery.
export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
      '**/.worktrees/**',
    ],
  },
});
