# ADR-0035 前端框架终态：全量 Solid 化

- **日期**：2026-10-01
- **状态**：已采用（维护者裁决，2026-10-01 全项目审计决策轮）

## 背景与约束

- 生产代码三套 UI 运行时并存：React 111 文件、solid-js 67 文件、zustand 33 文件；`package.json` 同时依赖 `react@19` 与 `react18`/`react-dom18` 别名（第二份 React，唯一消费点是 1 个集成测试）。
- workbench 主渲染面已 Solid 化（`src/renderers/solid-workbench/`，67 个 `.solid` 实体）；React 守着 `components/`、`sheets/`、`workspace-sheets/`。
- 双框架桥 `src/host/solidStoreBridge.ts` 自述「迁移终点是 store 全量 Solid 化，届时此桥与 zustand 一并退役」（#279），但该终点从未被裁决——审计（P1-④）将「迁移无终点锚点」列为跨区块病根：每个迁移都缺「何时拆桥」的判据，桥与兼容层有变成永久居民的趋势。
- 约束：本 ADR 只裁决方向与判据，不设迁移排期；过渡期仓库必须保持可发布（`check:all` 全绿）。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| 双框架长期共存（写死边界目录、停止迁移） | 双运行时心智与包体成本永久化；桥、别名、两套测试设施成为永久居民；与 #279 桥文件自述的终点相悖 |
| 回归 React 单框架（叫停 Solid 化） | 已迁的 67 个 Solid 文件与 workbench 主面（最高频流式场景，Solid 粒度响应式的选择原因）成为反转包袱；方向掉头代价比走完更大 |

## 决定

1. **终态 = 全量 Solid 化**：React 全部退出生产树；zustand 与 `solidStoreBridge` 随最后一批迁移一并退役。
2. **过渡期口径：新增 UI 组件一律 Solid**——保证终态裁决后无需反向搬运新代码，债务只减不增。
3. **终点判据**：`src` 生产代码内 `react` / `zustand` import 清零、`solidStoreBridge` 删除；`react18`/`react-dom18` 别名不待终态、随卫生批先行移除。
4. 迁移施工与结构拆分批（#486）协调：agent-workbench 归位、上帝组件拆分等涉及文件大动的项优先以 Solid 落位，避免同一文件二次翻动。

## 后果

- 正面：单一框架心智；去掉 zustand 与双 React 依赖；桥与 React 侧薄桥面最终消失；终态判据可机器化（import 扫描即可判定）。
- 负面：Settings/Sheets/组件层约 111 个 React 文件的迁移工作量大；`@codemirror` 等 React 生态集成面需要 Solid 等价封装；迁移完成前双框架并存的测试设施（React18 别名之外的两套 testing library）仍要维护。
- 风险：迁移停滞则终态悬空——由「新 UI 一律 Solid」口径托底，保证停滞不放大债务；存量 React 面仅在被动触碰时按需迁移。

## 证据

- `package.json:105`：`react18`/`react-dom18` 别名（npm:react@^18.3.1）。
- `src/host/solidStoreBridge.ts:9-16`：「迁移终点是 store 全量 Solid 化，届时此桥与 zustand 一并退役」。
- 审计报告 `.agents/spec/audit-20261001/C-frontend-domain.md` §3.2（框架量化）与 `00-overview.md` P1-④。
