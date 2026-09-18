// Vitest config for `npm test` (runs `vitest run --root tests`).
// Plain object (no `vitest/config` import) so config loading never depends
// on module resolution — the runner itself is installed by the orchestrator
// (root devDependencies: vitest ^2).
export default {
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
};
