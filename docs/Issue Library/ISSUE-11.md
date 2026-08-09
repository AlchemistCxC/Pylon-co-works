# ISSUE-11：Browser 新窗口请求接管

> 正式编号按 Release 实施依赖关系编排。原问题编号保留在正文中，便于追溯历史记录。

## 当前状态

- 正式编号：`ISSUE-11`
- 原问题编号：`#2`
- 状态：已交付（方案已写入）
- 依赖：独立；可与 ISSUE-07/ISSUE-02 并行
- 简介：将 target=_blank/window.open 安全接管到当前 Browser Sheet。
- 来源：`docs/release-issues.md`

## 并行执行元数据

```yaml
formal_id: ISSUE-11
status: 已交付（方案已写入）
lane: browser
priority: P1
stage: integration
size: M
dependencies: []
blocks: []
likely_modify: ["src-tauri/src/browser.rs", "src/sheets/browser/"]
do_not_modify: ["不实现多 Browser 实例"]
execution_rule: "先完成任务卡依赖，再领取本 Issue 的 ready slice；跨 Lane 变更必须经 contract/checkpoint。"
```

> 此处是 Harness 的机器可读入口。Issue 级状态不等于所有 slice 完成；以 `harness/queue.json`、任务卡和 checkpoint 为准。

## 原始问题记录

原问题编号：#2
严重度：P1
状态：已交付（方案已写入）

问题现象：
宫木云汇报：
“Pylon 应用内打开 Browser Sheet，输入地址 `www.baidu.com` 后进入百度搜索；搜索 `bilibili`，结果弹出后，无法进入任意一个网页。”

触发条件：
1. 打开 Browser Sheet 并启动内嵌 WebView。
2. 地址栏输入 `www.baidu.com`。
3. 在百度中搜索 `bilibili`。
4. 点击任意搜索结果。
5. 页面没有进入目标网页。

问题根因：
Browser 子 WebView 只配置了 `on_navigation`，没有配置新窗口创建处理。百度搜索结果链接可通过 `target="_blank"` / `window.open` 请求创建新 WebView；该请求不属于当前 WebView 的普通导航，因而不会进入现有 `on_navigation` 回调，也没有任何 `on_new_window` handler 将目标 URL重定向到当前子 WebView。结果是新窗口请求无人承接，用户点击后看起来“没有反应”。

证据等级：
- L1 直接证据：本轮遵循 Harness 只诊断模式，未启动 Release 做 WebView2 现场抓包，故没有 `NewWindowRequested` 运行日志；复现现象由宫木云提供。
- L2 源码证据：
  - `G:/Project/prism-desktop/src-tauri/src/browser.rs:134-154`：`WebviewBuilder` 只注册 `.on_navigation(...)` 和 `.on_page_load(...)`，不存在新窗口请求处理。
  - `G:/Project/prism-desktop/src-tauri/src/browser.rs:202-217`：`browser_navigate` 只覆盖 Pylon 地址栏主动导航，不会处理网页内部 `target=_blank`。
  - `G:/Project/prism-desktop/src/sheets/browser/BrowserSheetView.tsx:118-127`：前端 `navigate()` 只在 Pylon 自身地址栏 Enter 时调用 `browser_navigate`。
  - 全仓非 Markdown 源码搜索没有发现 `on_new_window`、`new_window`、`window.open` 或 `target_blank` 的接管逻辑。

已排除的假设：
- 已排除“普通 http/https URL 被安全白名单拒绝”：`on_navigation` 明确放行 `http`、`https`，地址栏进入百度也证明普通导航可用。
- 已排除“Browser WebView 未启动”：百度首页和搜索结果能够渲染，说明子 WebView 已处于 ready。
- 已排除“前端透明 DOM 覆盖所有网页点击”：网页内容由原生 child WebView 渲染，不在 React DOM 内；且问题集中在搜索结果出站链接。

相关源代码：
- `G:/Project/prism-desktop/src-tauri/src/browser.rs:118-171`
- `G:/Project/prism-desktop/src-tauri/src/browser.rs:202-217`
- `G:/Project/prism-desktop/src/sheets/browser/BrowserSheetView.tsx:118-127,170-185`

解决方案：

方案 A（推荐，将新窗口请求改为当前 Browser Sheet 内导航）：
- 改动位置：`G:/Project/prism-desktop/src-tauri/src/browser.rs`，`BrowserManager::start()` 构造 `tauri::WebviewBuilder` 的位置。
- 具体改法：
  1. 给 child WebView 注册 Tauri v2 对应的新窗口创建回调。
  2. 回调只接受 `http` / `https` URL；拒绝 `file`、`javascript`、`data`、`devtools` 等 scheme。
  3. 对允许的目标 URL，不创建新应用窗口，而是调用当前 `pylon-browser` WebView 的 `navigate(url)`，并取消原新窗口创建。
  4. 复用当前 URL 白名单函数，不在 `on_navigation`、`navigate()` 和新窗口回调中复制三份 scheme 判断。
  5. 导航成功后仍由现有 `on_page_load` 更新地址栏和 title。
- 影响面：将网站“新标签页/新窗口”行为映射为当前 Browser Sheet 内导航；普通同页链接行为不变。Pylon 当前没有多标签浏览器，因此这是与现有产品能力最一致的降级语义。
- 验证方式：
  1. 百度搜索 `bilibili`，点击普通结果和明确新窗口结果，均在当前 Browser Sheet 打开。
  2. 测试 `target="_blank"` 的本地 HTTP fixture。
  3. 测试 `window.open('https://example.com')` fixture。
  4. 测试 `window.open('file:///...')`、`javascript:`、`data:`，必须拒绝。
  5. 打开后地址栏收到 `pylon:browser-page` 并更新 URL。
  6. 后退按钮可以返回搜索结果页。
- 风险与取舍：网站期望的新窗口被改为同页导航，会丢失 opener 与多窗口语义；但当前 Pylon 没有 tab/window 管理，这是推荐取舍。实现时必须依据当前 Tauri 2.11 API 的真实新窗口 hook 签名落地，禁止猜 API。

方案 B（不推荐，真正创建第二个 Browser 实例）：
- 改动位置：`browser.rs`、`BrowserManager` 单实例状态、前端 Browser Sheet registry 与 tab 管理。
- 具体改法：把 `BrowserManager` 从单 `webview: Option<Webview>` 改成 instance map，并为网页新窗口创建独立 Browser Sheet。
- 影响面：新增多浏览器实例、窗口/tab 生命周期和持久化语义，显著扩大业务范围。
- 验证方式：多结果同时打开、分别关闭、切换 Sheet、实例 bounds 和历史独立。
- 风险与取舍：当前 `BROWSER_WEBVIEW_LABEL` 固定、Browser Sheet singleton，无法低风险支持多实例；不建议作为本 Bug 修复。

---

### 源码复核后的实施细化

1. 当前 `BrowserManager` 是单实例 `webview`，已有 `navigate()` 的 http/https 校验和 `on_page_load` 地址同步；推荐复用，不创建第二实例。
2. 先从当前锁定的 Tauri 2.11 依赖源码确认 `WebviewBuilder` 新窗口回调的真实方法名、回调参数、取消创建方式和线程约束；当前项目源码不存在任何 `on_new_window` 接管，不能凭经验写 API。
3. 统一 `is_allowed_browser_url`，让地址栏 `navigate`、`on_navigation`、新窗口回调共用 scheme 规则；`about:blank` 只作为初始页，不应自动放行外部新窗口中的 file/data/javascript。
4. 新窗口回调接到 http/https 后，应在 Tauri 主线程调用当前 child WebView `navigate`，并明确返回“取消原窗口创建”的结果；若 API 不支持直接复用当前 WebView，则退回在 WebView2 原生层处理，不要伪造成功。
5. 用本地 HTTP fixture 覆盖普通链接、`target=_blank`、`window.open`、恶意 scheme 和后退；百度仅作为真实站点回归，不作为唯一自动化证据。

可行性：方向中高、API 落地待依赖源码确认。当前 `browser.rs` 的单实例结构非常适合方案 A，方案 B 不应进入本 Bug。

---


## 逐项验收清单

### 6.12 问题 #2：Browser 新窗口请求接管

#### 等级 1：测试通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| URL 白名单 | http/https 允许；file/javascript/data/devtools/chrome 拒绝；about 仅允许初始化约定 | `src-tauri/src/browser.rs` Rust unit tests | [ ] |
| 本地 fixture | 普通链接、`target=_blank`、`window.open` fixture 可区分并触发预期 handler | Browser fixture/integration tests | [ ] |
| 地址同步 | 接管导航后仍由 page-load 更新 URL/title，后退历史可用 | Browser manager tests | [ ] |

#### 等级 2：前端网页验收通过（仅限前端）

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| Browser 前端壳 | 地址栏、前进/后退/刷新、错误提示和 URL 展示正常 | `http://localhost:5173/` → Browser Sheet | [ ] |
| Tauri 新窗口接管 | 网页模式没有真实 child WebView/NewWindowRequested；本等级只验前端壳，不得标记原生接管完成 | `http://localhost:5173/` → Browser Sheet | [-] |

#### 等级 3：真实应用验收通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| 百度搜索结果 | 百度搜索 `bilibili` 后点击任意结果，在当前 Browser Sheet 打开 | 真实应用 → Browser Sheet → `https://www.baidu.com` | [ ] |
| target/window.open | 本地 fixture 的 `_blank` 和 `window.open` 均同页打开，不创建孤儿窗口 | 真实应用 → Browser Sheet → 本地 HTTP fixture URL | [ ] |
| 恶意 scheme | file/javascript/data 等新窗口请求被拒绝，Runtime 日志可见且应用不崩溃 | 真实应用 → Browser Sheet fixture；Runtime Sheet | [ ] |
| 历史行为 | 接管后地址栏更新，后退返回搜索结果页 | 真实应用 → Browser Sheet | [ ] |

## 施工日志

| 2026-08-09 | 拍板决策同步 | 已将本轮已确认的产品决策与当前实施成熟度写入“已拍板决策”。未形成措施的内容明确标注为仅有决策。 | 关联未决策项见 `未决策项.md` |
| 日期 | 类型 | 记录 | 证据/备注 |
|---|---|---|---|
| 2026-08-09 | 文档拆分 | 从 `docs/release-issues.md` 拆分为 `ISSUE-11`；保留原问题记录、追加调查、修复记录与三级验收内容。 | 本文件生成于 Issue Library 初始化 |
|  |  |  |  |


## 本轮源码核验与可验收子任务（2026-08-09）

### 逐条源码核验矩阵

| 原主张 | 判定 | 当前源码证据 | 方案修正 |
|---|---|---|---|
| Browser 是单 child WebView | 属实 | `src-tauri/src/browser.rs:134-141,202-216` | 新窗口请求复用当前 WebView，不创建平行实例。 |
| 当前已有 new-window hook | 不属实 | 当前 builder 仅见 `on_navigation`，未见 new-window callback | 先从锁定 Tauri 版本源码确认 API，再实现拦截。 |
| URL 白名单已有基础 | 属实 | `browser.rs:141,202-216,303-309` | 抽成共享 scheme helper，地址栏/navigation/new-window 共用。 |


> 本节是本轮对当前源码的增量审计与执行切分。原编号只用于追溯；以下 task id 才是 Harness v2 的执行单位。

### 核验结论
- 🟡 当前 `BrowserManager` 单实例与 URL 校验可复用，但仓库源码未出现新窗口 callback；API 签名必须先以当前 Tauri 依赖源码确认。证据：`src-tauri/src/browser.rs`、`src-tauri/Cargo.lock`。

### 子任务清单

| Task ID | 类型 | 归属 | 依赖 | 验收标准 | 最低证据 |
|---|---|---|---|---|---|
| `I11-A-BE-01` | BE | A | 无 | 确认 Tauri Webview 新窗口 API 与安全 scheme contract；以当前依赖源码/API 文档证据确认 callback 签名；不凭经验写 on_new_window。 | L1 |
| `I11-A-BE-02` | BE | A | I11-A-BE-01 | 单 Browser WebView 新窗口复用；http/https 导航到现有 child WebView，恶意 scheme 拒绝，不创建第二实例。 | L3 |
| `I11-A-TEST-01` | TEST | S | I11-A-BE-02 | Browser fixture 与真实 WebView 验收；fixture 覆盖 target blank/window.open/恶意 scheme/后退；真实应用验证拦截。 | L3 |

### 本轮施工日志

| 2026-08-09 | 源码核验 + 任务切分 | 已对照当前源码建立证据结论；按一张卡一个独立可验收结果切分，B 视觉任务仅在基座/契约明确后进入。 | `docs/Issue Library/harness-v2/` |
