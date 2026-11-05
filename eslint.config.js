// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

/** Network modules are allowed only in the guarded client (spec §11.4 rule 7, §18.2). */
const NETWORK_IMPORTS = {
  paths: ['undici', 'node:http', 'node:https', 'http', 'https', 'google-gax'].map((name) => ({
    name,
    message: 'Outbound calls go only through @dcam/http-guard (spec §11.4 rule 7).',
  })),
  patterns: [
    {
      group: ['@google-cloud/*'],
      message: 'Google SDKs are not used; call REST through @dcam/http-guard (ADR-0006).',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/src/generated/**',
      // Claude Code agent worktrees: full copies of the repository, linted in their own checkout.
      '.claude/worktrees/**',
      'docs/**',
      '.turbo/**',
      'coverage/**',
      '.remember/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Fakes and Fastify handlers are async by contract even when they do not await.
      '@typescript-eslint/require-await': 'off',
    },
  },
  // Tests read untyped JSON bodies and third-party fixtures.
  {
    files: ['**/test/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  // Plain JavaScript (config files, hooks, scripts): no type information.
  { files: ['**/*.{js,mjs,cjs}'], ...tseslint.configs.disableTypeChecked },
  // Product code: no network modules, no direct fetch, outside the guard.
  {
    files: ['apps/**/src/**/*.{ts,tsx}', 'packages/**/src/**/*.{ts,tsx}'],
    ignores: ['packages/adapters/http-guard/src/**'],
    rules: {
      'no-restricted-imports': ['error', NETWORK_IMPORTS],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Outbound calls go only through @dcam/http-guard (spec §11.4 rule 7).' },
        { name: 'XMLHttpRequest', message: 'Outbound calls go only through @dcam/http-guard.' },
      ],
    },
  },
  // Web UI: React hooks and accessibility rules.
  {
    files: ['apps/web/**/*.{ts,tsx}', 'packages/ui-kit/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  { files: ['apps/web/**/*.tsx', 'packages/ui-kit/**/*.tsx'], ...jsxA11y.flatConfigs.recommended },
);
