"""Pylon release 打包：exe + resources 全部必要组件 → pylon-1.0.4-win64.zip。

路径显式解析（不依赖调用方 cwd）：脚本自身位于 <repo>/scripts/，
release 产物位于 <repo>/src-tauri/target/release/。
"""
import os
import zipfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(SCRIPT_DIR)
RELEASE_DIR = os.path.join(REPO_DIR, "src-tauri", "target", "release")
OUT_ZIP = os.path.join(REPO_DIR, "pylon-1.0.4-win64.zip")

EXE = "pylon.exe"


def main() -> None:
    exe_path = os.path.join(RELEASE_DIR, EXE)
    if not os.path.isfile(exe_path):
        raise SystemExit(f"release exe 不存在: {exe_path}（先跑 npx tauri build）")

    with zipfile.ZipFile(OUT_ZIP, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(exe_path, EXE)
        resources_dir = os.path.join(RELEASE_DIR, "resources")
        if os.path.isdir(resources_dir):
            for root, _dirs, files in os.walk(resources_dir):
                for f in files:
                    full = os.path.join(root, f)
                    zf.write(full, os.path.relpath(full, RELEASE_DIR).replace(os.sep, "/"))
        else:
            print("warn: resources 目录不存在，仅打包 exe")

    print(f"OK: {OUT_ZIP} ({os.path.getsize(OUT_ZIP):,} bytes)")
    with zipfile.ZipFile(OUT_ZIP) as zf:
        for i in zf.infolist():
            print(f"{i.file_size:>12,}  {i.filename}")


if __name__ == "__main__":
    main()
