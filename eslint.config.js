import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'release/**', 'evidence/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'vitest.config.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prefer-const': 'off',
      'no-useless-escape': 'off',
    },
  },
  {
    files: ['test/**/*.mjs', 'scripts/**/*.mjs', 'src/api/static/**/*.js'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', URL: 'readonly' },
    },
  },
];
