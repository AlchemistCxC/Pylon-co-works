# ADR-0010 留言板唯一权威位置与归档惯例

> 入库保留。编号顺延，按编号命名。
> 产出路径：`.agents/decisions/0010-board-single-authority-and-archive-location.md`

- **日期**：2026-09-18
- **状态**：已采用（用户当场逐条裁定）

## 背景与约束

- **板子有过两处，且在分叉。** 2026-09-14 协作文档重组时留言板迁至 `.agents/BOARD.md`，根 `BOARD.md` 被删除（`a96dff9e`）。同日晚些时候根板被「按 HEAD 恢复」（`29620fde`）——`.agents/BOARD.md` 里对此留痕：「像刚扫干净的院子被善意地扫回了原样」。此后两份板子各自收条目：根板至 09-15 23:20，`.agents/BOARD.md` 至 09-15 03。而 `AGENTS.md` §5 文件地图只认 `.agents/BOARD.md`。
- **根板体积已构成上下文风险。** 341,198 B / 999 行。`grep BOARD.md` 一旦命中它并整读，就是十万 token 量级的上下文——是 `AGENTS.md`（5.4KB）的 63 倍。
- **归档惯例在仓外。** 本项目的台账、施工书与旧文档归档在协作工作区 `G:\Project\prism-team-workdir\Docs\Archive\`；`README.md`、`CONTEXT.md`、`docs/说明书/Pylon-项目架构参考.md` 都以 `../Docs/` 指向它。`scripts/check-doc-links.mjs:6-8` 的注释自述：只校验仓内指针，跨仓库路径无法在门禁成立故不纳入——**仓外指针不受任何门禁保护**。
- **仓内仓外同形。** 仓外 `Docs/` 与仓内 `docs/` 在 Windows 上指向同一目录名形态，写成 `Docs/Archive/…` 时无法分辨所指。`.agents/BOARD.md` 里那条归档记录正因此被读成「仓内不存在此路径」——实际是仓外路径少了 `../`。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| 根板继续在岗，删 `.agents/BOARD.md` | 与 `AGENTS.md` §5 文件地图冲突；`.agents/` 已是协作元数据的家（records/decisions/templates/spec 都在此） |
| 根板 `git rm` 彻底删除 | 旧施工书与旧记录里「写 root `BOARD.md`」的措辞仍在，遵循者会就地重建一个空白根板，容易再回到双板 |
| 全文归档到仓内 `docs/Archive/` | 与既定仓外归档惯例冲突，等于凭一次清理发明第三处归档地；且仓内 `docs/` 是产品说明书树 |
| 只保留根板全文、在文档里声明其已退役 | 体积与误读两个问题都没解决 |

## 决定

1. **留言板唯一权威位置是 `.agents/BOARD.md`。** 根 `BOARD.md` 降为约 1KB 的路标（指向在岗板、`L.md` 与归档），不再接收条目；其退位前全文快照落仓外 `../Docs/Archive/BOARD-archive-20260918.md`（含 09-14 04:03 快照之后一直未归档的约 17KB 增量）。
2. **归档一律落仓外 `Docs/Archive/`**，遵循既有惯例；引用仓外一律写 `../Docs/…`，仓内一律小写 `docs/`。
3. **纯追加型协调文件**（`.agents/L.md`、两份 `BOARD.md`、`.agents/records/`）的合并冲突**取并集**，不适用「冲突一律以 `main` 为准」——这类冲突的成因恒为「两边各追加了不同条目」。
4. **`.agents/L.md` 只留在途声明**；条目对应的 issue 合入后即可移除，旧条目轮转入仓外归档。

## 后果

- 正面：全仓不再有 341KB 的可 grep 巨物；留言板位置唯一且写进 `AGENTS.md`；`L.md` 从 471 行降到 174 行——既降读取代价，也缩小合并冲突面（该文件历史上多次成为合并冲突点）。
- 负面：仓外归档不在版本控制内，新克隆与 CI 看不到它。这与既有归档惯例同源，不是本次引入；退位前全文另有 git 历史兜底（`git show 17148d6f:BOARD.md`）。
- 风险：`.agents/spec/` 下一次性施工书里「写 root `BOARD.md`」的措辞未改（该目录不入库、用完即弃）。选「路标」而非「删除」正是为了让这些遵循者被重定向而不是就地重建。

## 证据

- 协作规范：`AGENTS.md` §2.1（共享工作树与纯追加豁免）、§2.3-4（L.md 轮转）、§5（文件地图与 `../Docs/` 约定）
- 路标桩：`BOARD.md`
- 轮转规则：`.agents/L.md` 表头
- 门禁自述仓外指针不纳入：`scripts/check-doc-links.mjs:6-8`
- 归档实物：`../Docs/Archive/BOARD-archive-20260914.md`（324,438 B）、`BOARD-archive-20260918.md`（341,198 B）、`L-archive-20260918.md`（307 行）
