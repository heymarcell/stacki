import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// These tests run inside workerd, against a real Durable Object with real
// SQLite storage. That is the point: a mocked DO would test the mock's idea of
// atomicity, and atomicity is most of what this relay is for.
//
// `@cloudflare/vitest-plugin` is the current package — `vitest-pool-workers`
// is its earlier name and its `./config` entry point no longer exists. Checked
// against the Cloudflare docs rather than remembered.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    // The conformance suite waits out a real invitation expiry.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
