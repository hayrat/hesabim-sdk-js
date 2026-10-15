import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    environmentOptions: {
      happyDOM: {
        // Every test runs as if it were the SPA served from this origin, which
        // is what the redirect-URI and returnTo rules are written against.
        url: 'https://app.example.com/',
      },
    },
    setupFiles: ['src/test-support/setup.ts'],
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
