# 测试驱动与证据等级

## 每张任务卡三要素

1. `tests`：先失败后通过的自动化测试或明确说明为何只能做 characterization test。
2. `commands`：可从仓库根运行的相对命令。
3. `required_level`：任务关闭所需最低证据等级。

## 等级

- `L1`：自动化测试、类型检查、lint、build、diff check；证明代码契约。
- `L2`：前端网页/Preview 的真实交互、布局、可访问性、截图或录屏；不证明 Tauri/ACP/系统 WebView。
- `L3`：真实 Tauri 应用、真实 ACP/Peri/Hermes、SQLite、Gateway、系统 WebView 或真实账号链路。

## 默认命令

按任务范围选择，不得机械全跑；合并 checkpoint 再跑完整矩阵。

```bash
npm run test
npm run build
npm run lint
git diff --check
cd src-tauri && cargo check
cd src-tauri && cargo test --lib --no-run
cd src-tauri && cargo test --lib
```

命令必须以实际 `package.json`/`Cargo.toml` 为准，任务卡创建时核验。

## TDD

- Bug：先写能复现根因的 focused test 或 evidence capture，再修。
- 功能：先冻结输入/输出/状态转换 contract，再写测试。
- 视觉/动效：先建立稳定 DOM selector、静态 fallback、reduced-motion 和性能采样基线，再实现效果。
- 没有自动化入口时，先创建最小 harness/fixture；不得只凭人工观感提交。

## 证据记录

handoff 记录命令、exit code、测试数量、失败项、截图/日志相对路径、运行 commit。不得填写没有真实运行的结果。
