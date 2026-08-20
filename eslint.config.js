// eslint flat config（ESLint 9 + typescript-eslint + react-hooks）
// 目标：抓未使用变量 / React hooks 违规 / 未定义引用；不做风格警察。
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  { ignores: ['dist', 'dist-solid-smoke', 'node_modules', 'src-tauri'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // TS 已做类型检查；no-undef 关闭避免与 TS 重复
      'no-undef': 'off',
      'no-unused-vars': 'off',
      // ignoreRestSiblings：store partialize 的"解构排除"模式（{ a, b, ...rest }）是合法用法
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
      // 空 catch 块是本项目有意为之（静默降级，如剪贴板权限缺失）
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    files: ['**/*.tsx'],
    ignores: ['src/renderers/solid-workbench/**/*.solid.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['src/renderers/solid-workbench/**/*.solid.tsx'],
    rules: {
      // Solid ref 指令由编译器赋值，ESLint 静态分析无法识别。
      // ESLint 10.8.0 中 no-unassigned-vars 为 core 规则（实测 print-config [2]），
      // 此处 'off' 为必要抑制；ISSUE-20"幻影规则"判断基于旧版 ESLint，记为 fixed_stale_doc。
      'no-unassigned-vars': 'off',
    },
  },
  {
    files: ['src/**/*.test.{ts,tsx}'],
    rules: {
      // 测试文件允许未使用变量/any
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
)
