import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // *.db.test.ts files share one rehearsal schema and TRUNCATE it: never run files in parallel.
    fileParallelism: false,
  },
});
