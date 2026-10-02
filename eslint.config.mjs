/*
Known issues:
 1. Warning "ExperimentalWarning: Importing JSON modules is an experimental feature and might change at any time" can
 appear if you are using Node.js v20.10.0. This isn't an issue, just warning. Update to Node.js v20.18.3 to solve this.
 https://github.com/sindresorhus/eslint-plugin-unicorn/issues/2561
 */

import path from 'path';
import { fileURLToPath } from 'node:url';
import globals from 'globals';

// Import each plugin’s flat config or recommended config.
import jsPlugin from '@eslint/js';
import tseslint from 'typescript-eslint';
import jestPlugin from 'eslint-plugin-jest';

import importPlugin from 'eslint-plugin-import';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import promisePlugin from 'eslint-plugin-promise';
import unicornPlugin from 'eslint-plugin-unicorn';
import prettierConfigRecommended from 'eslint-plugin-prettier/recommended';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rulesGlobalOld = {
    'no-console': ['warn', { allow: ['warn', 'error'] }],

    strict: ['error', 'global'],
    curly: 'warn',
    'prefer-template': 'error',
    'max-len': [
        'error',
        {
            tabWidth: 4,
            code: 120,
            ignoreComments: true,
            ignoreTrailingComments: true,
            ignoreTemplateLiterals: true,
            ignoreStrings: true,
            ignoreRegExpLiterals: true,
        },
    ],
    quotes: [
        'error',
        'single',
        {
            avoidEscape: true,
        },
    ],

    // require variables to be used before defined
    '@typescript-eslint/no-use-before-define': 'error',

    // Now it's not possible to fix this in the whole project, but let's not do it in new code
    '@typescript-eslint/no-explicit-any': 'error',

    // don’t require explicit return values for functions
    '@typescript-eslint/explicit-module-boundary-types': 'off',

    // might report false positives with TS
    'no-shadow': 'warn',
    '@typescript-eslint/no-shadow': 'warn',

    'import/extensions': [
        'off',
        'ignorePackages',
        {
            ts: 'never',
            tsx: 'never',
        },
    ],

    // defaults props are problematic with TS and function components
    'react/require-default-props': 'off',

    // conflicts with prettier <-- this is from the old linter, commented by now
    // 'react/jsx-one-expression-per-line': 'off',
    // 'react/jsx-indent': 'off',
    // 'react/jsx-indent-props': 'off',
    // 'react/prop-types': 'off',
    // 'react/jsx-curly-newline': 'off',
    // 'react/jsx-wrap-multilines': 'off',
};

const rulesGlobalNew = {
    '@typescript-eslint/consistent-type-definitions': 'off',
    semi: ['error', 'always'],
    'prettier/prettier': ['error'],
    'object-curly-spacing': ['warn', 'always'],
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-unused-vars': ['error'],
    '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
    'prefer-template': 'off',
    'linebreak-style': 'off',
    'no-empty': 'error',
    'import/no-cycle': 'off',
    'prefer-destructuring': 'off',
    'no-underscore-dangle': 'off',
    'react/react-in-jsx-scope': 'off',
    'no-multiple-empty-lines': [
        'error',
        {
            max: 1,
            maxEOF: 1,
            maxBOF: 0,
        },
    ],
    'no-useless-return': 'off',
    'no-param-reassign': 'off',
};

const rulesTsNew = {
    // Unicorn //
    'unicorn/no-null': 'warn',
    'unicorn/filename-case': [
        'error',
        {
            cases: {
                kebabCase: false,
                pascalCase: true,
                camelCase: true,
            },
        },
    ],
    'unicorn/prevent-abbreviations': 'off',
    'unicorn/consistent-function-scoping': [
        'error',
        {
            checkArrowFunctions: false,
        },
    ],
    'unicorn/no-useless-undefined': [
        'error',
        {
            checkArrowFunctionBody: true,
        },
    ],
    'unicorn/no-object-as-default-parameter': 'warn',

    // Others //
    'consistent-return': 'off',
    'react/jsx-no-duplicate-props': ['error', { ignoreCase: false }],
    'jsx-a11y/label-has-associated-control': 'warn',
    'jsx-a11y/alt-text': 'off',
    'react/function-component-definition': 'off',
    'import/no-unresolved': 'error',
    'import/order': [
        'warn',
        {
            alphabetize: {
                caseInsensitive: true,
                order: 'asc',
            },
            groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
            'newlines-between': 'always-and-inside-groups',
            pathGroups: [
                {
                    pattern: 'react',
                    group: 'external',
                    position: 'before',
                },
                {
                    group: 'internal',
                    pattern: 'generated/*',
                },
            ],
            pathGroupsExcludedImportTypes: ['builtin'],
        },
    ],
    'import/no-absolute-path': 'warn',
    'import/no-extraneous-dependencies': [
        'error',
        {
            peerDependencies: true,
        },
    ],
    'unicorn/prefer-global-this': 'off',
    '@typescript-eslint/consistent-indexed-object-style': 'off',

    // Turned off //
    // 'react-hooks/exhaustive-deps': 'warn',
};

/** @type {import('@typescript-eslint/utils').TSESLint.FlatConfig.ConfigFile} */
export default tseslint.config(
    jsPlugin.configs.recommended,
    tseslint.configs.recommended,
    tseslint.configs.stylistic,
    promisePlugin.configs['flat/recommended'],

    // For all files //
    {
        // Specify ignored files
        ignores: [
            'rspack.*',
            'ci.*',
            'dist/**',
            'build/**',
            'coverage/**',
            'node_modules/**',
            '.cache/**',
            '.eslintcache',
            '*.min.js',
            '*.bundle.js',
            '__tests__/fixtures/**',
            '__mocks__',
        ],
        languageOptions: {
            parserOptions: {
                // For typescript-eslint, https://typescript-eslint.io/getting-started/typed-linting/
                project: './tsconfig.json',
                tsconfigRootDir: __dirname,
                parserServices: true,
                sourceType: 'module',
                ecmaVersion: '2022',
                allowImportExportEverywhere: true,
                ecmaFeatures: {
                    jsx: true,
                    modules: true,
                },
            },

            // Any global variables go here
            globals: {
                google: 'readonly',
                ga: 'readonly',
                tippy: 'readonly',
                fbq: 'readonly',
                getCookie: 'readonly',

                // Jest
                ...jestPlugin.environments.globals.globals,

                // Additional environment globals
                ...globals.builtin,
                ...globals.browser,
                ...globals.serviceworker,
                ...globals.commonjs,
                ...globals.node,
                ...globals.es5,
                ...globals.jquery,
            },
        },
        settings: {
            react: {
                version: 'detect',
            },

            // https://github.com/import-js/eslint-import-resolver-typescript
            'import/resolver': {
                typescript: {
                    alwaysTryTypes: true,
                },
            },
        },

        rules: {
            ...rulesGlobalOld,
            ...rulesGlobalNew,
        },
    },

    // Non-typed linting for old JS files //
    {
        name: 'super-linter-non-typed',
        files: ['**/*.{js,jsx,mjs,cjs,mjsx}'],
    },

    // Typed linting for TypeScript files //
    {
        name: 'super-linter-typed',
        files: ['**/*.{ts,tsx,mtsx}'],

        extends: [
            tseslint.configs.recommendedTypeChecked,
            tseslint.configs.stylisticTypeChecked,
            importPlugin.flatConfigs.recommended,
            importPlugin.flatConfigs.typescript,
            reactPlugin.configs.flat.recommended,
            reactPlugin.configs.flat['jsx-runtime'],
            reactHooksPlugin.configs.flat['recommended-latest'],
            unicornPlugin.configs.recommended,
        ],

        plugins: {
            react: reactPlugin,
            'jsx-a11y': jsxA11y,
        },

        languageOptions: {
            ...reactPlugin.configs.flat.recommended.languageOptions,
        },

        rules: {
            // React
            'react/jsx-uses-react': 'error',
            'react/jsx-uses-vars': 'error',

            // Unicorn
            'unicorn/better-regex': 'warn',

            ...rulesTsNew,
            ...rulesGlobalOld,
            ...rulesGlobalNew,
        },
    },

    // Linting Jest test //
    {
        name: 'super-linter-jest',
        files: ['**/*.(test|spec).{js,ts,tsx}'],
        plugins: { jest: jestPlugin },
        languageOptions: {
            globals: globals.jest,
        },
        rules: {
            'jest/no-disabled-tests': 'warn',
            'jest/no-focused-tests': 'error',
            'jest/no-identical-title': 'error',
            'jest/prefer-to-have-length': 'warn',
            'jest/valid-expect': 'error',
        },
    },

    prettierConfigRecommended // Always should be the last one
);
