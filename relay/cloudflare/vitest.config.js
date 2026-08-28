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
      // The test runtime opts out of the abuse guard explicitly, exactly as a
      // local `wrangler dev --env development` does. Room creation is refused
      // by default now, so a suite that wants rooms has to say so — which is
      // the point: the default is the safe one and every exception is written
      // down somewhere a person can read.
      miniflare: { bindings: { STACKI_ALLOW_UNLIMITED_RELAY: '1' } },
    }),
  ],
  test: {
    // The conformance suite waits out a real invitation expiry.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
