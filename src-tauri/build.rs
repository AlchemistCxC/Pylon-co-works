fn main() {
    // tauri-build 默认 manifest 与 icons/manifest.rc 相同（均为 comctl32 v6 声明）。
    // 关闭默认 manifest，manifest 全 PE 统一只此一份——避免双 manifest
    // 冲突（".rsrc merge failure: multiple non-default manifests"）。
    #[cfg(target_os = "windows")]
    let attributes = {
        let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        tauri_build::Attributes::new().windows_attributes(windows)
    };
    #[cfg(not(target_os = "windows"))]
    let attributes = tauri_build::Attributes::new();

    tauri_build::try_build(attributes).expect("tauri-build failed");

    // Windows 所有 target（bin + lib 单元测试 harness）需要 comctl32 v6 manifest
    // （TaskDialogIndirect 入口点，缺失时 harness 崩溃 0xc0000139）。
    // 资源编译统一走 embed_resource：MSVC target 由 Windows SDK 的 rc.exe 完成
    // （tauri-winres 同款 SDK 探测），不再依赖 MinGW windres——本机已无 MinGW
    // 工具链，windres NotFound 曾使 build:release 直接 panic（2026-09-06）。
    // 图标不在此嵌入：tauri-winres 已按窗口图标（id 32512）嵌入，本 rc 只补
    // manifest（1 24），双 .res 各含 .ico 会因内部 RT_ICON 条目撞车报 CVT1100。
    //
    // compile_for_everything 发射 plain rustc-link-arg，覆盖 bins/tests/examples/
    // benches 全部 target。
    #[cfg(target_os = "windows")]
    {
        println!("cargo:rerun-if-changed=icons/manifest.rc");
        embed_resource::compile_for_everything("icons/manifest.rc", embed_resource::NONE)
            .manifest_required()
            .expect(
                "failed to compile icons/manifest.rc (comctl32 v6 manifest); \
                 MSVC-only toolchain requires Windows SDK rc.exe",
            );
    }
}
