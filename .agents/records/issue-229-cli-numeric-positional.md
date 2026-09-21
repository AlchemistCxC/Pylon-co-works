# Dev Record — issue229 CLI 纯数字 positional 拒收修复

## 元信息

- issue：#229（bug：壳层把纯数字 positional 转成 JSON number，string 参数命令拒收）
- 分支：`Ru5t/Reflector`
- 提交：`ed14e4e5`（L.md）+ `66a87542`（修复，与 #230 同提交）
- 日期：2026-09-22
- 发现源：#36 实机验收（报告者 id 非纯数字故原 issue 未触发）

## 目标与范围

`pylon-cli interaction respond 7 allow_once`（照抄列表数字 id 走 positional）必须可用。壳层 `parse_value` 的 JSON 类型化**不动**（`--timeout`、数字 flag 等依赖它）——修 TS 侧。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/cli/pylonCliService.ts` | 新增 `scalarString`（有限 number 无损转 string），`stringArg`/`optionalString` 收编 | 修改 |

## 方案要点

按 O27（env 标量宽松化）先例：服务层按参数类型收编壳层送来的标量，壳层保持「值一律 JSON 类型化」的通用设计不变。positional 与 `--flag` 两条路径同时覆盖。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 纯数字 positional respond | ✅ native：`interaction respond 7 allow_once` → `responded:true` |
| 数字 flag（`--requestId 7`） | ✅ 单测覆盖 |
| `--args` JSON 字符串形式不回归 | ✅ #36 验收序列复跑全绿 |

## 测试处置

新增：`accepts numeric positionals/flags as strings for string-typed args (#229)`（positional number + flag number 两断言）。

## 证据

- 测试：`npx vitest run src/cli/__tests__/pylonCliService.test.ts` → **18 passed**
- native：fake-agent `permission-proactive`（requestId 7）挂起后，`pylon-cli --json interaction respond 7 allow_once` → `{"ok":true,...,"responded":true}`，复查 list 为空
- 排障备注：验收用 agents.yaml 若以双引号标量写 Windows 路径，`\A` 类非法 YAML 转义会使整份配置解析回退为空表（本轮实测踩到，改用 `\\` 或裸标量）

## 与 spec 的偏差

无 spec（bug 修复，方案在 issue 正文）。

## 未解问题

无。

## 并行交集

与 #230 同提交（`66a87542`）；文件域见 L.md `[2026-09-22 01]` 条目。
