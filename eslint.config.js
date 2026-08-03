// eslint flat config（ESLint 9 + typescript-eslint + react-hooks）
// 目标：抓未使用变量 / react-hooks 违规 / 未定义引用；不做风格警察。
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'src-tauri'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
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
    files: ['src/**/*.test.{ts,tsx}'],
    rules: {
      // 测试文件允许未使用变量/any
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
)
