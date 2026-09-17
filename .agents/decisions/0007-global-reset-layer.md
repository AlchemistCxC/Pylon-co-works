# ADR-0007 全局元素 reset 落入 `@layer base`，恢复 spacing utility

> 入库保留。产出路径：`.agents/decisions/0007-global-reset-layer.md`

- **日期**：2026-09-17
- **状态**：已采用

## 背景与约束

`src/index.css` 的全局 reset `*, *::before, *::after { margin:0; padding:0; box-sizing:border-box }` 长期处于**未分层**区，而 Tailwind 的 spacing utility（`p-*` / `px-*` / `m-*` / `mt-auto` …）全部由 `src/styles/tailwind.css` 引入 `@layer utilities`。按 CSS Cascade Layers 规范，未分层样式优先于一切分层样式——于是**没有任何存量类**的纯 utility 元素上，`padding` / `margin` 恒被 reset 压回 0。

约束（不可违反）：

1. `box-sizing: border-box` 的全局默认有既有依赖（P93 第五块明载 `ProfileEditor` 的 `.pe-input/.pe-select`「无自有样式（box-sizing 由全局 reset 覆盖）直接退役」），**不得删除该行为**。
2. 「不引 preflight」是 Tailwind 引入施工书的硬约束——但那条禁令针对的是**引入 Tailwind 自带 base reset**（会全局重置元素默认值、破坏 29 份既有 CSS 的视觉前提），与「把现有手写 reset 移入低优先层」不是一回事，不新增任何 reset 内容。
3. 「未分层 CSS 恒压 utilities」对**存量类**仍是期望行为（第一方插件 CSS 以 `?inline` 未分层挂载），本次修复不得推翻该约定。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| 逐处把 spacing utility 换成内联样式或存量类 | 治标：病灶是层叠序，每新增一个 utility 元素都会再犯；且与样式绞杀路线（P93）方向相反——绞杀队列里的每个包都会继续静默流失 spacing |
| 引入 Tailwind preflight / base reset | 违反约束 2：会全局重置元素默认值，破坏既有 CSS 的视觉前提 |
| 删除全局 reset，让各组件自带 `box-sizing` | 违反约束 1：直接破坏 `.pe-input/.pe-select` 的退役前提 |
| **把现有 reset 原样移入 `@layer base`，并显式声明层序** | 采用 |

## 决定

`src/index.css` 顶部显式声明层序并承载 reset：

```css
@layer base, theme, utilities;

@layer base {
  *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }
}
```

- 层序显式声明而不依赖引入顺序（`main.tsx` 先 `index.css` 后 `tailwind.css`，但显式声明让顺序不成为隐式前提）。
- `box-sizing` 与 reset 同进 `@layer base`：base 层仍低于 UA 默认样式源之外的一切作者声明，且高于 UA 默认值，故 `border-box` 的生效范围不变。
- 相对优先级因此固定为：**未分层第一方 CSS（含存量类）> utilities > base(reset) > UA**。

## 后果

- 正面：spacing utility 在纯 utility 元素上恢复生效；首方包 plugin-manager 的 `px-3 py-2.5` / `ml-auto` 等意图重新成立；后续绞杀包不再静默流失 spacing。
- 负面 / 风险：原本被 reset 压制的声明会「浮起来」——所有此前**写了却没生效**的 spacing utility 现在生效，可能改变既有外观。这类回归无法靠单元测试判定（jsdom 不应用 CSS），只能靠实机比对。
- 风险处置：修复后对全部 sheet + 主界面 + 17 个设置页面做了一轮实机比对（见开发记录），并对**中控区**取了 DOM + 计算样式指纹做前后对照（该区域零 spacing utility，指纹逐字节一致）。
- 护栏：`src/__tests__/cascadeLayerContract.test.ts` 锁定「层序声明存在」「reset 在 base 层内且保留 box-sizing」「reset 不以未分层形态再次出现」。

## 证据

- `src/index.css:1-13`
- `src/styles/tailwind.css:1-8`（头部不变量注释同步说明 reset 所在层）
- `src/__tests__/cascadeLayerContract.test.ts`
- `.agents/dev-standards.md:37`（样式节限定语）
- 实机对照：`.agents/records/issue-116-frontend-audit-remediation.md`
