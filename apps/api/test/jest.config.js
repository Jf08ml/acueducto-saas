module.exports = {
  rootDir: '..',
  testRegex: 'test/.*\\.e2e-spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'test/tsconfig.json' }] },
  testEnvironment: 'node',
  setupFiles: ['dotenv/config'],
  testTimeout: 30000,
};
