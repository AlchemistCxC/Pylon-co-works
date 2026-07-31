fn main() {
    tauri_build::build();

    // Windows 测试 target 需要 comctl32 v6 manifest（TaskDialogIndirect 入口点）。
    // 注意：不能写 #[cfg(test)]——build script 编译时 test cfg 恒为 false，
    // 原代码该条件从未生效，导致测试 exe 无 manifest、加载 5.82 版 comctl32 而崩溃
    // (0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND)。
    // cargo 无 lib 单元测试专属 link 指令（link-arg-tests 只认显式 [[test]]，
    // link-arg-lib 不覆盖 lib 的 test harness），用全局 link-arg 兜底。
    #[cfg(target_os = "windows")]
    {
        embed_resource::compile("tests/windows-test-manifest.rc", embed_resource::NONE)
            .manifest_required()
            .unwrap();
        let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR set by cargo");
        println!("cargo:rustc-link-arg={out_dir}/libwindows-test-manifest.a");
    }
}
