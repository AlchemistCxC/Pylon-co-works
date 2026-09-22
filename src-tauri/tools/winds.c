/*
 * windres 启动垫片（#245 自 src-tauri/ 根归档至此，内容未改）。
 *
 * 用途：winres/tauri-winres 在 GNU 工具链下需要调 windres，而部分发行版的
 * windres 是 shell 脚本，Windows CreateProcess 无法直接 spawn；把本文件用
 * `gcc winds.c -o winds.exe` 编译产物放进 PATH 即可代为转发参数。
 *
 * 现状：本仓构建走 x86_64-pc-windows-msvc（tauri-winres 用 rc.exe），MSVC
 * 与 CI 链路均不引用本文件；仅作 GNU 工具链时代的存档保留，删除与否由
 * 仓库主裁决（issue #245）。
 */
#include <process.h>
int main(int argc, char **argv) {
    const char *args[256];
    args[0] = "windres";
    int i;
    for (i = 1; i < argc && i < 255; i++) args[i] = argv[i];
    args[i] = 0;
    return _spawnv(_P_WAIT, args[0], args);
}
