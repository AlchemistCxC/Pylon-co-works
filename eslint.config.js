// eslint flat config（ESLint 9 + typescript-eslint + react-hooks）
// 目标：抓未使用变量 / React hooks 违规 / 未定义引用，并约束内部绑定命名。
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
      // Only internal bindings: wire / storage properties and destructured keys retain their contracts.
      '@typescript-eslint/naming-convention': ['error',
        { selector: ['variable', 'parameter'], modifiers: ['destructured'], format: null },
        { selector: 'variable', format: ['camelCase', 'PascalCase', 'UPPER_CASE'], leadingUnderscore: 'allow' },
        { selector: 'parameter', format: ['camelCase', 'PascalCase'], leadingUnderscore: 'allow' },
      ],
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
  {
    // P91 §10 / P95：Plugin Host 依赖边界——原 pluginHostSeam.test.ts 的 readFileSync
    // 源码正则（3 个 seam 文件禁 import ../kernel/ 与 *runtimeServices）迁移至此，由
    // linter 静态执行。scope 收窄到与原测试完全相同的 3 个文件：plugin-runtime 内
    // 其余模块不在该边界内（pluginManagementWiring 的 KernelBootstrap type import、
    // runtimeServices 模块自身及其消费方都是既有合法引用，扩大 scope 会误伤打红）。
    files: [
      'src/plugin-runtime/pluginRuntime.ts',
      'src/plugin-runtime/pluginInstance.ts',
      'src/plugin-runtime/pluginActivationContext.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/kernel', '**/kernel/*'], message: 'Plugin Host seam 不得依赖 kernel（激活期经 scope API 注入）。' },
          { group: ['**/*runtimeServices', '**/*runtimeServices/*'], message: 'Plugin Host seam 不得依赖全局 runtimeServices。' },
        ],
      }],
    },
  },
)
