# #266 遗留 CC-12 · 思考强度「对称守卫」开发记录

- **日期**：2026-09-24
- **分支**：`fix/cc-266-remaining`（从 `main` 开）
- **原件**：`E:\Acode\FILES\任务\工作台优化\04-施工单-思考强度对称守卫（待排期）.md`（本轮做完后归档）
- **来源**：由 `03-施工单-权限菜单虚空（当前值冒充候选面）` 拆出（权限那条已完工）；`#156` 记录 `.agents/records/156-control-center-truth-sync.md` 遗留类
- **性质**：bug 修复（潜伏型；本机当前不发作）

---

## 1. 病灶（一句话）

三个同款下拉框里，**权限、模型**两条已经装了"清单里除当前值外什么都没有 ⇒ 视作没上报 ⇒ 用兜底表"的守卫，
**思考强度**这条没装 —— 于是同一个陷阱在这个控件上仍然可复现：provider 报了当前值却没给候选清单时，
菜单会只剩当前值一项（而当前值又要从候选里排掉）⇒ **空盒且换不回去**。

机理（沿用 `03` 单的定位）：`resolveDocumentOptionEntries` 在 provider **没给 choices** 时会回落
成单元素列表 `[{ id: current }]`（`workbenchOptionCatalog.ts:212-224`）⇒ `advertised` 非空 ⇒
`preferAdvertised` 认为"它报过了" ⇒ **本地 8 档兜底表被丢掉**。

## 2. 改动

`src/renderers/solid-workbench/input/workbenchOptionCatalog.ts` —— `resolveReasoningOptionEntries`：

```ts
// 改造前
const advertised = documentOptions(snapshot, 'reasoning')
return mergeEntries([preferAdvertised(advertised, DEFAULT_REASONING_OPTIONS)], current)

// 改造后
const advertised = documentOptions(snapshot, 'reasoning')
const currentValue = current ?? resolveDocumentOptionValue(snapshot.document?.session.options, 'reasoning')
return mergeEntries([preferAdvertised(advertisedChoices(advertised, currentValue), DEFAULT_REASONING_OPTIONS)], currentValue)
```

两处，缺一不可：

1. **补守卫**：`advertisedChoices(advertised, currentValue)` —— 与权限（`:290`）、模型两条**同形**；
2. **比对基准定死为文档值**（原单 §二 的要求）：形参缺省时自己从文档读。
   ★ 只补第 1 处是不够的：若基准系在形参上，会话态下形参为空 ⇒ `advertisedChoices` 原样放行 ⇒ **守卫静默失效**。

### 与原件相比的一处事实更正

原件 §二 说"调用侧传进来的 `current` 是**草稿值**（会话态通常是 `undefined`）"。**现状已不是这样**：
唯一调用点 `WorkbenchWidgets.solid.tsx:94` 传的就是
`resolveDocumentOptionValue(runtime().document?.session.options, 'reasoning')`（文档值）。
⇒ 陷阱只剩"少了守卫"这一半；但为了不依赖调用方，本轮仍把基准在函数内兜一层（缺省自读）。

## 3. 验收

| 项 | 结果 |
|---|---|
| 定向测试 | `workbenchOptionCatalog.test.ts` **17 passed**（原 12 + 新增 5） |
| ★ 反向验证 | 把守卫改回 `preferAdvertised(advertised, …)`（其余不动）⇒ **3 条变红**，报错原文正是病灶形状：`expected [ 'high' ] to deeply equal [ 'none','minimal','low',… ]`、`expected [ 'ultra-custom' ] to include 'low'` ⇒ 改回即绿 |
| 门禁 | `lint` 0 error（唯一 warning 是存量 `RightRailHost.tsx`）/ `build:example-plugin` / `build` ✓ 8.55s / `check:solid` 11 项全过（含 CSS 消费审计、187 字段一致性、运行时边界）|
| 全量 | 见 §4 |

新增的 5 条用例（逐条对应一类输入）：

1. provider 只报当前值、没给清单 ⇒ **兜底表**；
2. ★ 当前值**不在**兜底表里（`ultra-custom`）⇒ 兜底档全体回来 + 当前值仍在（未加守卫时这里只有 1 项）；
3. 真候选面（带 choices）⇒ **用它**，不回落；
4. 既无候选面也无当前值 ⇒ 兜底表；
5. ★ **形参不传、文档里有值** ⇒ 守卫仍生效（专挡"基准系在形参上"的写法）。

## 4. 全量

`bun run test` 在施工后的树上跑了 **两次**：

| 次 | 结果 |
|---|---|
| 第 1 次 | **1 failed / 639 passed / 1 skipped（641 文件）**，用例 1 failed / 4851 passed → ★ **命中的是已登记的渲染器线 flake**：`PlainMessageList.solid.test.tsx > #243：换代把窗口收敛到新会话尾部`（`expected [ 'b0'… ] to include 'b299'`，与选项目录无关）。**隔离连跑 3 次全绿**（各 16 passed） |
| 第 2 次 | ✅ **640 passed + 1 skipped（641 文件）/ 4852 passed + 1 skipped + 1 todo（4854）**，EXIT=0 |

★ 门禁四步（`lint` / `build:example-plugin` / `build` / `check:solid`）在施工后树上全绿，见 §3。

## 5. 遗留 / 注意

- **发作条件仍在**：本机 Hermes 不上报思考强度选项 ⇒ 走兜底表 ⇒ 表面无症状。要现场复现需一个
  "报了选项但不给 choices"的 provider（或临时构造文档）。本轮以单测 + 反向验证取证。
- **未做**（不在本单）：`optionIds` 把当前值塞进候选列表这件事本身（`hostPortSolidServices.ts:137-138`）——
  它是"当前值冒充候选面"的源头机制，三条解析各自用守卫兜住即可，本轮不动它。
- **原件已归档**：`E:\Acode\FILES\任务\工作台优化\已处理\04-施工单-思考强度对称守卫（待排期）.md`。

---

## 6. 施工过程留痕（给后来者）

★ **反向验证时别用 `git checkout -- <file>` 还原未提交的修复** —— 那会把修复本身一起还原（本轮踩过一次，
发现后重贴修复并复跑）。正确做法：先 `cp` 一份工作树副本，改坏后从副本恢复。
