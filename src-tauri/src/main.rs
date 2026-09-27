// #361：发行构建是 GUI 子系统（PE `OptionalHeader.Subsystem` = 2），debug 构建保留
// console 子系统（= 3）以便 `tracing` 的 stderr sink 与 `run()` 前的 `eprintln!`
// 兜底可见。缺这一行时 release 的 `pylon.exe` 默认落在 console 子系统，双击启动
// 会分配并显示一个控制台窗口——而发行 zip 顶层没有启动器脚本，`README.txt` 就是
// 让用户直接双击 `pylon.exe`。
//
// 该属性只对 Windows 目标有效，且必须位于 crate 根（`lib.rs` 上的同类属性不作用于
// 二进制 crate 的 PE 头）。其它 bin 入口（`src/bin/` 自动发现的 `pylon-cli` /
// `pylon-detect`，以及显式 `[[bin]]` 的 `pylon-fake-agent`）都是给人读输出的控制台
// 工具，各自是独立的 crate 根、天然不受此处影响，**故意不加**。
//
// 依赖顺序：改为 GUI 子系统后，任何未带 `CREATE_NO_WINDOW` 的子进程 spawn 都会
// 开始弹黑框（console 子系统下它们附着在父控制台上所以看不见）。全仓生产 spawn
// 的覆盖收口在 `pylon_foundations::child_command::HideConsoleWindow`。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // #269：进程 t0——必须先于一切可观测工作（含 init_tracing）。
    prism_desktop_lib::startup_mark("process_entry");
    // #362：绑定落盘 worker 的存活守卫到进程生命周期——drop 即关闭写入线程并 flush，
    // 漏绑会静默丢掉缓冲区里还没落盘的尾巴（所以 init_tracing 的返回带 #[must_use]）。
    let _log_guard = prism_desktop_lib::init_tracing();
    prism_desktop_lib::run();
}
