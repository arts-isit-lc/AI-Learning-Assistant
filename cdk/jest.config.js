module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        target: 'ES2020',
        module: 'node16',
        moduleResolution: 'node16',
        esModuleInterop: true,
        skipLibCheck: true,
        strict: true,
        noUnusedLocals: false,
        noUnusedParameters: false,
        types: ['jest', 'node'],
      },
    }],
  },
};
