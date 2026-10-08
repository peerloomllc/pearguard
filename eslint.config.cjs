// Narrow lint: only rules that catch real bugs (an undefined name, a
// duplicate key, unreachable code), not style. Prettier owns formatting.
// Run by `npm run verify` through `npm run lint`.
const globals = require('globals')

const rules = {
  'no-undef': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-duplicate-case': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-const-assign': 'error',
  'no-self-assign': 'error',
  'no-unreachable': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
}

module.exports = [
  { ignores: ['**/node_modules/**', 'assets/**', 'android/**', 'ios/**', 'desktop/vendor/**', 'desktop/dist/**', 'dist/**', '.superpowers/**'] },
  {
    // Bare worklet and shared backend modules (CommonJS).
    files: ['src/**/*.js'],
    ignores: ['src/ui/**'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node, Bare: 'readonly', BareKit: 'readonly' },
    },
    rules,
  },
  {
    // WebView React UI (ES modules + JSX).
    files: ['src/ui/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    rules,
  },
  {
    // Desktop child (Electron main, preload and renderer).
    files: ['desktop/src/**/*.js', 'desktop/tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
    rules,
  },
  {
    files: ['tests/**/*.js', 'test/**/*.js', '**/*.test.{js,jsx}', '**/__tests__/**/*.{js,jsx}'],
    languageOptions: {
      globals: { ...globals.jest, ...globals.node },
    },
  },
]
