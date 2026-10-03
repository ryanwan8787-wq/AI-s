// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['coverage/**', 'out/**', 'dist/**', 'release/**', 'node_modules/**', 'sidecar/**', '*.config.*'] },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-invalid-void-type': 'off', // 事件表用 void 表示「無 payload」
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      // 模組邊界：shared 不得 import main/renderer/preload；renderer 與 main 不得互相 import
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/main/**', '**/renderer/**', '**/preload/**', 'electron', 'three', 'node:*'], message: 'shared 必須保持純淨：不得依賴執行環境或其他程序的實作' }] },
      ],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/main/**', 'electron', 'node:*'], message: 'renderer 只能透過 window.companion（preload）與 main 溝通' }] },
      ],
    },
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/renderer/**'], message: 'main/preload 不得 import renderer 實作' }] },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
);
