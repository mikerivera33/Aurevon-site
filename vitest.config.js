import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      'coverage/**',
      '.claude/**',
      '.superpowers/**',
      'node_modules/**',
    ],
    coverage: {
      provider: 'v8',
      include: [
        'api/webhooks/**',
        'api/_lib/{crossmint,tiers,entitlements,email,fulfil,alert}.js',
      ],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: { lines: 80, functions: 80 },
    },
  },
});
