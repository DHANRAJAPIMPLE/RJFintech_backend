import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // ✅ Unused vars
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // ✅ Naming convention (camelCase enforcement)
      '@typescript-eslint/naming-convention': [
        'error',

        // variables, functions, params
        {
          selector: 'variableLike',
          format: ['camelCase'],
        },

        // constants
        {
          selector: 'variable',
          modifiers: ['const'],
          format: ['camelCase', 'UPPER_CASE'],
        },

        // types (class, interface, type)
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },

        // object properties (strict camelCase)
        {
          selector: 'property',
          format: ['camelCase'],
        },

        // allow special cases (Prisma + headers)
        {
          selector: 'objectLiteralProperty',
          format: null,
          filter: {
            regex: '^(OR|AND|NOT|Content-Type|Authorization)$',
            match: true,
          },
        },
      ],

      // optional
      '@typescript-eslint/no-explicit-any': 'off',
    },
  }
);