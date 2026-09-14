module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { browser: true, node: true, es2022: true },
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
  ignorePatterns: ['node_modules', '.vite', '.webpack', 'out', 'release', 'coverage', 'dist', 'data', 'cache', 'logs', 'temp'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'error',
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    // A conditional hook call makes React throw and unmount the whole tree (blank window),
    // so rules-of-hooks is an error; exhaustive-deps stays a warning.
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
  },
  overrides: [
    { files: ['tests/**/*', '*.config.ts', '*.config.js', '*.config.mjs'], rules: { 'no-console': 'off' } },
  ],
};
