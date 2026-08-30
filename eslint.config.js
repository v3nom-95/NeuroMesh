/**
 * NeuroMesh Protocol - ESLint flat configuration (ESLint 10, ESM).
 *
 * Layout of this file mirrors the repository layout:
 *   - Node ESM      : server.js, src/**, lib/**, scripts/**, test/**, tool configs
 *   - Browser ESM   : public/js/**
 * Formatting rules are disabled last by eslint-config-prettier; Prettier owns style.
 */
import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';

export default [
  // 1. Never lint generated, vendored or third-party output.
  {
    ignores: [
      '.wf/**',
      'node_modules/**',
      'artifacts/**',
      'cache/**',
      'coverage/**',
      '.nyc_output/**',
      'typechain-types/**',
      'reports/**',
      'dist/**',
      '.cache/**',
      'public/vendor/**',
      'package-lock.json',
      // Untracked developer scratch files. These mirror the "Local scratch files"
      // block in .gitignore: they are never committed, so CI never sees them, and
      // linting them only produces noise on the machine that happens to have one.
      'scratch_test.js',
      '.smoke-tmp.mjs',
      '.bench-tmp.mjs',
      '.conncheck.mjs',
    ],
  },

  // 2. Baseline correctness rules for every JavaScript file.
  js.configs.recommended,

  // 3. Node-side ESM: backend, protocol library, hardhat scripts, tool configs.
  {
    files: [
      // Root-level entrypoints and tool configs. The bare '*.js' / '*.mjs' globs
      // match the repository root only (flat config does not recurse without '**'),
      // so any future root-level script inherits Node globals instead of silently
      // falling through to the globals-less baseline and reporting no-undef.
      '*.js',
      '*.mjs',
      'server.js',
      'src/**/*.js',
      'lib/**/*.js',
      'scripts/**/*.{js,mjs}',
      'test/**/*.js',
      'hardhat.config.js',
      'eslint.config.js',
      'commitlint.config.js',
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.nodeBuiltin },
    },
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-var': 'error',
      'prefer-const': 'error',
      'object-shorthand': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-implicit-coercion': 'warn',
      'no-return-await': 'error',
      'require-atomic-updates': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',
    },
  },

  // 4. CLI-style code legitimately prints to stdout and exits with a status code.
  {
    files: ['scripts/**/*.{js,mjs}', 'test/**/*.js'],
    rules: {
      'no-console': 'off',
    },
  },

  // 5. Browser ESM: the dashboard. Must stay CSP-safe (no eval, no innerHTML sinks).
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-alert': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',
      'no-restricted-properties': [
        'error',
        {
          object: 'document',
          property: 'write',
          message: 'document.write is blocked by CSP; build nodes with the DOM API instead.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "AssignmentExpression[left.property.name='innerHTML']",
          message: 'innerHTML is an XSS sink; use textContent or the dom.js helpers.',
        },
        {
          selector: "AssignmentExpression[left.property.name='outerHTML']",
          message: 'outerHTML is an XSS sink; use textContent or the dom.js helpers.',
        },
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: 'insertAdjacentHTML is an XSS sink; use the dom.js helpers.',
        },
      ],
    },
  },

  // 6. Tests: both mocha/chai (hardhat contract suites) and node:test (backend/frontend).
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.mocha,
      },
    },
    rules: {
      'no-unused-expressions': 'off',
    },
  },

  // 7. Disable every stylistic rule that could fight Prettier. Must stay last.
  prettier,
];
