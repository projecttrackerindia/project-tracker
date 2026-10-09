import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: that one configures the dev server and the app build
// (proxying, the public-site plugin), neither of which unit tests need or should depend on.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
