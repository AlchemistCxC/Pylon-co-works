fn main() {
    // #269：进程 t0——必须先于一切可观测工作（含 init_tracing）。
    prism_desktop_lib::startup_mark("process_entry");
    prism_desktop_lib::init_tracing();
    prism_desktop_lib::run();
}
