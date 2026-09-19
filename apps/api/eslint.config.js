// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'src/lib/test-app.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any':      'error',
      '@typescript-eslint/no-unused-vars':       ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'error',
      'no-console':                              ['warn', { allow: ['log', 'warn', 'error'] }],
    },
  },
  {
    // Relax rules for test files
    files: ['src/**/*.test.ts', 'src/lib/test-app.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  }
);
