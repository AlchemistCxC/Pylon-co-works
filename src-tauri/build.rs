fn main() {
    tauri_build::build();

    if cfg!(target_os = "windows") {
        // Rust 的 lib test harness 不会经过 Tauri CLI 的最终二进制资源注入。
        // 没有 Common Controls v6 manifest 时，muda 会从系统 comctl32 v5
        // 导入 TaskDialogIndirect，进程会在执行任何测试前以 0xc0000139 退出。
        embed_resource::compile("tests/windows-test-manifest.rc", embed_resource::NONE)
            .manifest_required()
            .unwrap();
    }
}
