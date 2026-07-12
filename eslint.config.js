import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    // gen/ and target/ are ComponentizeJS build artifacts of the Astrid capsule
    // (generated bundles, not authored code) - linting them is pure noise.
    ignores: ['**/dist/**', '**/node_modules/**', 'data/**', '**/gen/**', '**/target/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-console': 'off',
      // TypeScript already reports undefined identifiers; avoid duplicate errors.
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
