import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import babelParser from '@babel/eslint-parser';

// Parses with Babel rather than typescript-eslint: the repo pins TypeScript 7, newer than
// typescript-eslint's supported range (it hard-refuses to run at all against it), and Babel's
// TS/JSX syntax stripping doesn't care which compiler version is installed. This is syntax-level
// linting only - no type-aware rules - which is fine here since tsc's own strict mode plus
// noUnusedLocals/noUnusedParameters already cover what type-aware lint rules would add.
const sharedRules = {
  // Only these two: the rest of eslint-plugin-react-hooks@7's "recommended" set is the new React
  // Compiler rule family (purity, immutability, set-state-in-render, static-components, ...) -
  // meant for a codebase opting into the compiler, not a correctness baseline for this one.
  // rules-of-hooks catches real hook-call-order bugs; exhaustive-deps is what the existing
  // eslint-disable comments throughout the codebase were already written against.
  'react-hooks/rules-of-hooks': 'error',
  'react-hooks/exhaustive-deps': 'warn',
  'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
  // Babel's parser doesn't resolve TS types, so these base rules misfire on valid TS-only syntax
  // (interfaces, type-only imports, enum members used only as types, etc.).
  'no-unused-vars': 'off',
  'no-undef': 'off',
  'no-redeclare': 'off',
  // False positives on the `(m = take(...)) && ...` / chained `else if ((m = take(...)))` idiom
  // used throughout reminders/time.ts and similar parsers: a shared scratch variable reassigned
  // per branch, read inside that branch (or just for its truthiness) - a deliberate, working
  // pattern, not a dead store. The rule's control-flow analysis doesn't track reads across that
  // shape reliably.
  'no-useless-assignment': 'off',
};

const plugins = { 'react-hooks': reactHooks, 'react-refresh': reactRefresh };

export default [
  js.configs.recommended,
  { ignores: ['dist', 'node_modules', 'e2e'] },
  {
    // Plain .ts: no JSX preset, so a generic call or type assertion like `foo<Bar>()` or
    // `<Bar>x` is never misread as a JSX tag.
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023, sourceType: 'module', globals: globals.browser,
      parser: babelParser,
      parserOptions: { requireConfigFile: false, babelOptions: { presets: ['@babel/preset-typescript'] } },
    },
    plugins,
    rules: sharedRules,
  },
  {
    files: ['**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2023, sourceType: 'module', globals: globals.browser,
      parser: babelParser,
      parserOptions: { requireConfigFile: false, babelOptions: { presets: ['@babel/preset-react', '@babel/preset-typescript'] } },
    },
    plugins,
    rules: sharedRules,
  },
];
