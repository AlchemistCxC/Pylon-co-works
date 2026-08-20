fn main() {
    // tauri-build 默认 manifest 与下方 test manifest 相同（均为 comctl32 v6 声明）。
    // 关闭默认 manifest，统一由 embed_resource 全局注入——避免 bin 双 manifest
    // 冲突（GNU ld 报 ".rsrc merge failure: multiple non-default manifests"）。
    #[cfg(target_os = "windows")]
    let attributes = {
        let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        tauri_build::Attributes::new().windows_attributes(windows)
    };
    #[cfg(not(target_os = "windows"))]
    let attributes = tauri_build::Attributes::new();

    tauri_build::try_build(attributes).expect("tauri-build failed");

    // Windows 所有 target（bin + lib 单元测试 harness）需要 comctl32 v6 manifest
    // （TaskDialogIndirect 入口点）。注意：
    // 1. 不能写 #[cfg(test)]——build script 编译时 test cfg 恒为 false，
    //    原代码该条件从未生效，测试 exe 加载 5.82 版 comctl32 崩溃
    //    (0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND)。
    // 2. cargo 无 lib 单元测试专属 link 指令（link-arg-tests 只认显式 [[test]]），
    //    用全局 rustc-link-arg 兜底；tauri 默认 manifest 已关闭（见上）。
    //    注意：必须传 .o 而非 .a——gcc 把 .a 当库按符号提取，资源对象无符号会被跳过。
    #[cfg(target_os = "windows")]
    {
        let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR set by cargo");
        let obj = std::path::Path::new(&out_dir).join("windows-test-manifest.o");
        let windres = std::env::var("WINDRES").unwrap_or_else(|_| "windres".to_string());
        let status = std::process::Command::new(&windres)
            .arg("--input")
            .arg("tests/windows-test-manifest.rc")
            .arg("--output")
            .arg(&obj)
            .arg("--include-dir")
            .arg(&out_dir)
            .arg("--output-format=coff")
            .status()
            .expect("windres failed to run");
        assert!(status.success(), "windres failed to compile test manifest");
        println!("cargo:rustc-link-arg={}", obj.display());
    }
}
