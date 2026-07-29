fn main() {
    if cfg!(target_os = "windows") {
        embed_resource::compile("windows-test-manifest.rc", embed_resource::NONE)
            .manifest_required()
            .unwrap();
    }
}
