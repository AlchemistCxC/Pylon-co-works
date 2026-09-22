# Dev Record — #238 刀4 占区不叠加（编辑态碰撞约束）

> 入库保留。施工单：`E:\Acode\FILES\任务\工作台优化\元件定义表\06-施工单-刀4-占区不叠加.md`
> 规范：同目录 `00-施工规范-中控元件定义表-v1.0.md` §7；分支 `feat/cc-widget-definition-table`（刀1~刀4 同分支）

## 元信息

- issue：[#238](https://github.com/AlchemistCxC/Pylon-co-works/issues/238)
- 提交范围：`5af0f9e8..7298463e`（`d793da61` L.md 声明 → `7298463e` 实现）
- 日期：2026-09-22

## 目标与范围

编辑态下**元件占区不得相交**（用户口径「就像有碰撞体积」），**声明为悬浮的行豁免**（现只有发送按钮）；
相交时「挡住」——**推不动就贴着它滑**：全量候选 → 只水平 → 只垂直 → 保持原位（「回弹」是这个算法的自然结果，**没有**单独的回弹逻辑）。

**只在编辑态生效** ⇒ 常态界面不跑任何几何，像素与性能零变化。

**不做**：不消解存量重叠（§0-3 见下）；不做自动排布/换行重排；`order` 编辑不进约束；
不动 `ccLayoutState` 的数据语义（±48/±16 clamp 不变）；不动出厂数据、插件契约面、刀5/刀7 各项。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/renderers/solid-workbench/input/ccPlacementCollision.ts` | **纯几何**（不碰 DOM/store）：`rectsOverlap` / `resolveAllowedOffset`（四步算法）/ `parseTranslateOffset` / `shouldBypassCollisionConstraint` | 新增 |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | ★ 收敛通路：拖拽的 `move` 从"直连 dispatch"改成走带守卫的 `updatePlacement`；新增 `measureWidgetBox` + `allowedPlacement` | 修改 |
| `src/renderers/solid-workbench/input/WorkbenchWidgets.solid.tsx` | 发送按钮节点补 `data-widget-id`（纯属性，样式/布局不受影响） | 修改 |
| `src/renderers/solid-workbench/input/__tests__/ccPlacementCollision.test.ts` | 纯函数单测 16 条 | 新增 |
| `src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx` | 组件级 5 条（挡住 / 沿边滑 / **面板旁路** / 占区相交的非悬浮件被挡 / 常态零几何测量）+ 伪造布局夹具 | 修改 |

## 方案要点

1. **通路收敛（本刀第一个坑）**：改偏移原有两条通路 —— 拖拽 `move` **直连 dispatch**、面板输入框走 `updatePlacement`。
   只挂一条就会被另一条绕过（在面板里把「水平微调」直接输成重叠值一样能叠上去）。
   ⇒ 现在**两条都走 `updatePlacement`**，守卫只在那一个入口。
   ★ 停手条件 3 也查了：全仓 `update-cc-placement` 只有这两处（另有工具栏「重置控件位置」走 `reset-cc-layout`，
   它落到默认排布、天然不重叠且不是拖拽意图，不进约束）。
2. **算法**（`resolveAllowedOffset`）：① 全量候选 ② 只水平（保留上一次的 y）③ 只垂直（保留上一次的 x）④ 保持原位。
   判据 = 矩形**相交**（面积 > 0）；**允许贴合**、不加魔法间隙。
3. **测量**：几何判定全在视图层（数据层不碰 DOM）。每次调用**重新测量**障碍（不缓存 —— 拖动中可能换行回流）。
   被拖者自身的「矩形 + 偏移」取自**同一 DOM 快照**：偏移从元素自己的 inline `transform` 读回
   （`parseTranslateOffset`），不从 store 读 —— Solid 的事件里 DOM 更新可能还没落地，混用会算错一帧。
4. **编辑态限定 + 悬浮豁免**：三条短路写成纯函数 `shouldBypassCollisionConstraint`
   （非编辑态 / 悬浮件 / 只改 order），让"豁免"这件事**能被单测钉住**，而不是一句 if 的口头承诺。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 门禁五步 | ✅ 全绿 |
| 实机：挡住（交集 = 0，停在邻居边上） | ✅ offsetX 停在 **32**（不是 0）；与思考强度交集 **0**；右缘与邻居左缘亚像素贴合 |
| 实机：沿边滑（水平能走 / 垂直能走） | ✅ 左上拖 ⇒ x 走满 −40、y 停在 **−9.33**（顶上沿精确贴合输入栏下沿 726）且与输入栏交集 0；右下拖 ⇒ y 走满 +16、x 停在 30 且与邻居交集 0 |
| ★ 实机：面板旁路同样被挡 | ✅ 水平微调 48 ⇒ 保持 **0**；20 ⇒ 20；垂直 −16 ⇒ 0；+16 ⇒ 16 |
| 实机：悬浮豁免 | ✅ 发送按钮与输入栏交集 **1024 px²**（整按钮压在带内，预期）；面板把它改 48 ⇒ **48**（不被挡；对照：同一面板改 model 的 48 被挡） |
| 实机：常态零影响 | ✅ 进编辑态前后、退出编辑态后，几何与改造前基线**逐项相同** |
| 契约快照 | ✅ 只差 `generatedAt`（本刀不该改快照） |
| 反向验证 | ✅ 四条（见下） |
| 开发记录 | ✅ 本文件（含存量重叠处置） |
| 《中控元件总表》更新 | ✅ 仓外 |
| issue #238 回写 | ✅ |

## 证据

- **commit**：`d793da61`（L.md）→ `7298463e`（实现）
- **门禁（冻结态 `7298463e`，按顺序）**：

```text
$ bun run lint                  → LINT_EXIT=0（1 warning 在 RightRailHost.tsx，非本刀）
$ bun run build:example-plugin  → EP_EXIT=0
$ bun run build                 → BUILD_EXIT=0
$ bun run check:solid           → SOLID_EXIT=0
$ bun run test                  → TEST_EXIT=0；Test Files 627 passed (627)；Tests 4743 passed | 1 todo (4744)
```
对账：刀3 终点 626/4722 → 本刀 627/4743 = **+1 文件 / +21 用例 / 0 删除**（新增：纯函数 16 + 组件级 5）。

- **契约快照**：重拍后 `git diff` **只有 generatedAt 一行**，已还原 ⇒ 本刀确实没碰快照。

- **实机数值证据**（skill `webview2-acceptance`；普通 `cargo build` 的二进制 + **便携模式**隔离数据库；
  真实主题：cli + free、`ccHidden:["cc-send-button","attach"]`）：

```text
常态基线（改造前＝进编辑态之前，也与刀3 的实测逐项相同）：
  input (275,686,900×40) ｜ model (299,735,120×28) ｜ reasoning (452,735,132×28)
  mode (617,735,132×28) ｜ tokens (782,735,120→87×28)

① 挡住：把 model 往右拖（+1px × 48 步，真实 pointer 事件）
   → 存储 offsetX = 32、transform = translate(32px, 0px)
   → model 右缘 ≈451.x ｜ reasoning 左缘 ≈452.x ｜ 交集面积 = 0 ｜ 间隙 ≈1px（亚像素贴合）
   ⇒ 停在邻居边上，**不是**回弹到 0

② 沿边滑：左上拖 (−40,−16)
   → placement = (−40, −9.33)：x 走满；y 停在输入栏下沿（model.top = 726 = 输入栏 bottom）且交集 0
   右下拖 (+40,+16)
   → placement = (30, 16)：y 走满；x 被思考强度挡住（与邻居交集 0）
   ⇒ 两个方向都能"贴着滑"，不是整块卡死

③ ★ 面板旁路（属性面板的输入框，不走拖拽）：
   水平微调 48 → 存储仍是 0（被挡）｜20 → 20（不撞的进得去）
   垂直微调 −16 → 0（会顶进输入栏）｜+16 → 16（下方空闲）

④ 悬浮豁免：
   发送按钮 rect (1139..1171, 690..722)；输入栏 rect (275..1175, 686..726)
   → 交集面积 = 1024 px²（= 32×32，整按钮压在带内）—— **这是豁免不是 bug**
   → 面板把它水平微调改 48 ⇒ 得到 48（不被挡）；同一面板改 model 的 48 ⇒ 被挡 ⇒ 对照成立

⑤ 常态零影响：退出编辑态后 offset 全 0，几何与上面的「常态基线」逐项相同

控制台：只有既有的 `切换 Agent失败`（后端 source: agent）；本刀的拖拽/编辑交互**零报错**
数据复原：主题哈希回到 7a3cece2（与开测前一致）、临时键已删；用户 %APPDATA% 与备份逐字节相同（仅 SQLite 临时 -shm 不同）
```

- **反向验证**（改坏 → 变红 → 改回；改回后 `git diff` 为空）：

```text
A ★（单子点名要求）守卫只挂在面板通路上（拖拽退回直连 dispatch）
  × 拖拽：撞上邻居就停在**上一次被接受的位置**…   AssertionError: expected 48 to be 20
  × 拖拽：推不动就贴着它滑…                     AssertionError: expected -16 to be +0
  → 2 failed / 90 passed（★ 面板那条仍绿 ⇒ 精准证明"只挂一条通路"会被抓到）
B 守卫整体短路（allowedPlacement 直接 return partial）
  × 拖拽 ×2 + × 面板旁路 + × 占区相交的非悬浮件被挡   → 4 failed / 88 passed
C 删掉悬浮豁免 ⇒ 由纯函数单测承担（见「偏差 B」）
D 把「相交」判据改成面积 ≥ 0（贴合也算撞）
  × 边贴边不算撞 / × 贴合允许 / × 候选按 applied 换算   → 3 failed
```

## §0-3 存量重叠：**不消解**（有意接受）

用户 2026-09-22 原话：「老用户那个可以先放着，因为**后边要想办法强制更新到默认一遍**，到时候旧数据自然废弃」。
⇒ 本刀**只约束新的拖动/微调**：不加启动时"推开"、不加"首次运行消解"之类的半成品逻辑。
算法本身也与这条口径一致：兜底分支返回"上一次被接受的位置"，**即使那个位置本来就与老邻居重叠也不额外惩罚**
（`resolveAllowedOffset` 的单测里有一条专门钉这个）。后续「强制重置到默认」那一刀落地时，存量重叠与其它旧数据残留一并作废。

## 与 spec 的偏差

- **A. 给发送按钮节点补了 `data-widget-id="cc-send-button"`**（`WorkbenchWidgets.solid.tsx`）。
  原因：悬浮豁免按 id 找元素，而该节点此前**没有 id** ⇒ 豁免逻辑既测不到、在真机上也找不到它
  （它现在是可测量的 ⇒ 「悬浮件不当障碍」这条过滤才是**真在起作用**的，而不是空转）。纯属性，不影响样式与布局；
  实机复验发送按钮 rect 与改造前完全相同 (1139,690,32×32)。
- **B. 悬浮豁免的"端到端"单测受限**：预览环境里 `ccSendButtonRegistered()` 为假 ⇒ **发送按钮根本不渲染**，
  组件级测不到"它被放行"。处置：① 豁免判据抽成纯函数 `shouldBypassCollisionConstraint` 并单测（非编辑态 / 悬浮件 / 只改 order 三条）；
  ② 组件级保留"同一布局下非悬浮件被挡"的对照面；③ **端到端证据走实机**（上面 ④，含对照）。
- **C. 「贴上邻居」的落点是 32 而不是理论值 33**：真实布局的矩形带小数（`getBoundingClientRect` 返回 451.x / 452.x），
  整数偏移只能取到 32 ⇒ 实测"间隙 ≈1px（亚像素贴合）"。**没有**为此加任何魔法间隙或补偿（停手条件 1 的精神）。
- **D. 拖拽的"上一次被接受的位置"取自 DOM**：`previous` 直接传元素当前 inline `transform` 里的偏移，
  不另外在闭包里记一份 —— 与 `baseRect` 同源，天然避免"测量与状态差一帧"。

## 未解问题

1. 存量重叠待「强制重置到默认」那一刀（见上）。
2. 换行/回流抖动（停手条件 1）：本刀**未观测到**抖动 —— 实机用 +1px 步长连拖 48 步、以及两组 12 步斜拖都没出现"同一位置前后判定不一致"；
   也没做缓存/节流（停手条件 4：不凭感觉优化）。
3. 刀5（命令行提示翻可拖）落地时，它会进 `CC_EDIT_TOOLBAR_IDS` ⇒ 自动纳入本约束（无需再改守卫）；
   `floating` 名单里加人即可豁免。

## 并行交集

本刀触碰：`renderers/solid-workbench/input/{ccPlacementCollision.ts(新),ControlCenter.solid.tsx,WorkbenchWidgets.solid.tsx}`、
两份测试、`.agents/L.md`。

**未触碰**：`src/ccLayoutState.ts`（数据语义与 clamp 不变）、`src/domains/workbench/**`（store 落点不动）、
`src/zones/factory/**`、插件契约面、`src/ui-demo/`、`src/layout-sketch/`、`docs/前端接口地图.md`。
