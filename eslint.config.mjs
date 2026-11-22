import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

/**
 * ESLint covers JavaScript/ESM sources (scripts, benchmark suites, configs, tests).
 * TypeScript sources are checked by `pnpm typecheck` (tsc) and formatted by Prettier — this
 * avoids pinning a TypeScript parser to a version behind the project's TypeScript 7.
 */
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'packages/core/pkg/**',
      'target/**',
      'benchmarks/results/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Test files often destructure a value purely to trigger a getter or to mirror the API
    // surface under test; unused locals there are not a bug. tsc still checks the code.
    files: ['**/test/**/*.{js,mjs,cjs}', '**/*.test.{js,mjs,cjs}'],
    rules: { 'no-unused-vars': 'off' },
  },
  prettier,
];
