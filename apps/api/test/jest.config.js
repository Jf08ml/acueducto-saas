module.exports = {
  rootDir: '..',
  // e2e (contra la BD real) y unitarias (*.spec.ts, sin red ni BD).
  testRegex: 'test/.*\\.(e2e-)?spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'test/tsconfig.json' }] },
  testEnvironment: 'node',
  setupFiles: ['dotenv/config'],
  testTimeout: 30000,
};
