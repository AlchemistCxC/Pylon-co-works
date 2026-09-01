fn main() {
    // tauri-build 默认 manifest 与下方资源 manifest 相同（均为 comctl32 v6 声明）。
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
    // （TaskDialogIndirect 入口点）。tauri-winres 在 windows-msvc 下优先探测 rc.exe
    // （Windows SDK），本机未装 SDK 时 rc.exe 缺失 → tauri-winres 静默跳过资源嵌入
    // （2026-09-01 实测 MSVC 产物 PE 无 RT_GROUP_ICON）。windres（MinGW，GNU binutils）
    // 全程可用，生成 COFF 资源对象由 link.exe 链接。
    //
    // 注意：icon 与 manifest 必须合并为单个 .o 单个 rustc-link-arg——
    // MSVC link.exe 对多个 COFF 资源对象只取第一个（GNU ld 会合并），拆开会让
    // manifest 被丢弃（harness 加载 comctl32 5.82 崩溃 0xc0000139）。
    #[cfg(target_os = "windows")]
    {
        let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR set by cargo");
        let windres = std::env::var("WINDRES").unwrap_or_else(|_| "windres".to_string());
        let res_obj = std::path::Path::new(&out_dir).join("pylon-resources.o");
        let res_rc = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("icons/icon.rc");
        let status = std::process::Command::new(&windres)
            .arg("--input")
            .arg(&res_rc)
            .arg("--output")
            .arg(&res_obj)
            .arg("--output-format=coff")
            .status()
            .expect("windres failed to run");
        assert!(status.success(), "windres failed to compile resources (icon + manifest)");
        println!("cargo:rustc-link-arg={}", res_obj.display());
    }
}