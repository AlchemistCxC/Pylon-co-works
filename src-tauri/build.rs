fn main() {
    tauri_build::build();

    #[cfg(all(target_os = "windows", test))]
    {
        embed_resource::compile("tests/windows-test-manifest.rc", embed_resource::NONE)
            .manifest_required()
            .unwrap();
    }
}
