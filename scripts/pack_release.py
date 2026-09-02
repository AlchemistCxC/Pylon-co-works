"""Pylon Windows ZIP release packager（施工文档 Phase 1）。

产物布局：
    release/pylon-<version>-win64/
      pylon.exe
      pylon-detect.exe         # 独立 Agent 检测程序
      pylon-cli.exe            # CLI 工具（若存在）
      WebView2Loader.dll       # Tauri 启动必需（缺失 → 0xC0000135）
      resources/...            # 来自 src-tauri/target/release/resources
      agents.example.yaml      # 占位配置，绝不含真实 agents.yaml
      README.txt
      portable.flag
      data/                    # 空目录，触发 portable 模式
      tools/install-webview2.bat
      tools/repair-hermes-acp.bat/.ps1  # optional Hermes ACP stdin repair
      tools/MicrosoftEdgeWebview2Setup.exe   # 受控 release 资源，默认必须存在
      resources/runtime/git/...              # Hermes 专用 PortableGit（完整运行时）
      resources/sdk/pylon-plugin-sdk.js     # 离线插件 SDK（纯浏览器 ESM）
      resources/sdk/pylon-plugin-manifest.schema.json
    release/pylon-<version>-win64.zip
    release/pylon-<version>-win64.zip.sha256
    release/pylon-<version>-win64.manifest.json

脚本只负责收集、审计、压缩，不隐式执行构建；构建由 npm script 编排：
    npm run release:portable  =  build + tauri build --no-bundle + pylon-detect + pack
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import zipfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_DIR = SCRIPT_DIR.parent
SRC_TAURI_DIR = REPO_DIR / "src-tauri"
RELEASE_DIR = SRC_TAURI_DIR / "target" / "release"
TEMPLATE_DIR = REPO_DIR / "resources" / "release"
HERMES_RUNTIME_DIR = SRC_TAURI_DIR / "resources" / "runtime"
HERMES_RUNTIME_TREE = HERMES_RUNTIME_DIR / "git"
OUT_ROOT = REPO_DIR / "release"

EXE_NAME = "pylon.exe"
DETECT_EXE_NAME = "pylon-detect.exe"
TOP_DIR_PATTERN = re.compile(r"^pylon-[^/\\]+-win64/?$")

FORBIDDEN_NAMES = {
    "agents.yaml",
    ".env",
}
FORBIDDEN_SUFFIXES = (".pdb", ".rlib", ".d", ".key")
SENSITIVE_KEY_RE = re.compile(
    r"(?i)\b(api[_-]?key|access[_-]?token|client[_-]?secret|password|secret|token)\b\s*[:=]"
)
DRIVE_PATH_RE = re.compile(r"\b[A-Za-z]:[\\/]")
PLACEHOLDER_MARKERS = ("path\\to", "path/to", "your-", "example", "占位", "...")
# 插件开发 SDK：发行包附带完整离线分发包（2026-09-01 用户决定——不再只带最小
# runtime 子集，插件开发者需拿到 testing.js + types/ 类型声明全套）。
DEV_SDK_DIR = REPO_DIR / "dist-plugin-sdk" / "normal"
DEV_SDK_REQUIRED = frozenset({
    "pylon-plugin-sdk.js",
    "testing.js",
    "pylon-plugin-manifest.schema.json",
})


class PackError(Exception):
    pass


# ── 版本解析 ──

def parse_version_from_package_json() -> str:
    data = json.loads((REPO_DIR / "package.json").read_text(encoding="utf-8"))
    return str(data.get("version", "")).strip()


def parse_version_from_tauri_conf() -> str:
    data = json.loads((SRC_TAURI_DIR / "tauri.conf.json").read_text(encoding="utf-8"))
    return str(data.get("version", "")).strip()


def parse_version_from_cargo_toml() -> str:
    text = (SRC_TAURI_DIR / "Cargo.toml").read_text(encoding="utf-8")
    in_package = False
    for line in text.splitlines():
        if line.startswith("["):
            in_package = line.strip() == "[package]"
            continue
        if in_package:
            match = re.match(r'^\s*version\s*=\s*"([^"]+)"\s*$', line)
            if match:
                return match.group(1).strip()
    raise PackError("Cargo.toml [package] 段缺少 version")


def resolve_version() -> str:
    versions = {
        "package.json": parse_version_from_package_json(),
        "tauri.conf.json": parse_version_from_tauri_conf(),
        "Cargo.toml": parse_version_from_cargo_toml(),
    }
    unique = set(versions.values())
    if len(unique) != 1 or "" in unique:
        raise PackError(f"三处版本不一致: {versions}")
    return unique.pop()


# ── 文件审计 ──

def is_text_file(path: Path) -> bool:
    return path.suffix.lower() in {".txt", ".yaml", ".yml", ".bat", ".ps1", ".json", ".md"}


def is_hermes_runtime_payload(rel_path: str) -> bool:
    """Return whether *rel_path* belongs to the upstream vendor tree.

    The release audit's secret/absolute-path rules are for Pylon-authored
    configuration and documentation. PortableGit ships thousands of upstream
    docs and scripts containing harmless example paths and words such as
    ``token``; scanning those files creates false positives and does not add
    useful protection. Keep the structural/forbidden-name checks for the tree,
    but restrict content scanning to our own runtime metadata and README.
    """
    return rel_path.replace("\\", "/").startswith("resources/runtime/git/")


def scan_text_file(rel_path: str, text: str) -> None:
    for line_no, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped:
            continue
        if DRIVE_PATH_RE.search(stripped):
            if not any(marker in stripped for marker in PLACEHOLDER_MARKERS):
                raise PackError(
                    f"包内文本文件含疑似本机绝对路径 {rel_path}:{line_no}: {stripped}"
                )
        if SENSITIVE_KEY_RE.search(stripped):
            if not any(marker in stripped for marker in PLACEHOLDER_MARKERS):
                raise PackError(
                    f"包内文本文件含疑似敏感配置 {rel_path}:{line_no}: {stripped}"
                )


def reject_forbidden(rel_path: str) -> None:
    name = Path(rel_path).name
    posix = rel_path.replace("\\", "/")
    if name in FORBIDDEN_NAMES or name.endswith(FORBIDDEN_SUFFIXES):
        raise PackError(f"包内出现禁止文件: {rel_path}")
    if name.endswith(".env"):
        raise PackError(f"包内出现禁止文件: {rel_path}")
    if (
        posix == "src"
        or posix.startswith("src/")
        or posix == "src-tauri/src"
        or posix.startswith("src-tauri/src/")
        or posix == ".git"
        or posix.startswith(".git/")
        or posix == "node_modules"
        or posix.startswith("node_modules/")
    ):
        raise PackError(f"包内出现禁止路径: {rel_path}")


def hermes_runtime_is_complete(root: Path) -> bool:
    """Return whether a complete PortableGit tree is ready for packaging."""
    bash_candidates = [root / "bin" / "bash.exe", root / "usr" / "bin" / "bash.exe"]
    if not any(path.is_file() for path in bash_candidates):
        return False
    usr_bin = root / "usr" / "bin"
    required = ("true.exe", "cat.exe", "mktemp.exe", "mv.exe", "awk.exe", "grep.exe")
    if any(not (usr_bin / name).is_file() for name in required):
        return False
    return any(
        path.is_file()
        for path in (root / "usr" / "bin" / "msys-2.0.dll", root / "bin" / "msys-2.0.dll")
    )


def append_tree_files(
    files: list[tuple[Path, str]],
    source_root: Path,
    package_root: str,
) -> None:
    for root, _dirs, names in os.walk(source_root):
        for name in names:
            full = Path(root) / name
            rel = full.relative_to(source_root).as_posix()
            files.append((full, f"{package_root.rstrip('/')}/{rel}"))


def collect_dev_sdk() -> list[tuple[Path, str]]:
    """收集完整插件开发 SDK（dist-plugin-sdk/normal 全量）到 resources/sdk/。

    发行包附带完整离线 SDK 分发包：pylon-plugin-sdk.js（纯浏览器 ESM runtime）
    + testing.js（测试基建）+ types/ 全套类型声明 + manifest schema。
    """
    if not DEV_SDK_DIR.is_dir():
        raise PackError(
            f"缺少插件开发 SDK 目录: {DEV_SDK_DIR}。"
            "请先运行 npm run build:plugin-sdk，再打包。"
        )

    files = {
        path.relative_to(DEV_SDK_DIR).as_posix(): path
        for path in DEV_SDK_DIR.rglob("*")
        if path.is_file()
    }
    missing = sorted(DEV_SDK_REQUIRED - files.keys())
    if missing:
        raise PackError(
            f"插件开发 SDK 缺少文件: {', '.join(missing)}。"
            "请重新运行 npm run build:plugin-sdk。"
        )
    return [(path, f"resources/sdk/{rel}") for rel, path in sorted(files.items())]


def collect_source_files(version: str, without_webview2: bool, with_runtime: bool = False) -> list[tuple[Path, str]]:
    """返回 [(源文件绝对路径, 包内相对路径（不含顶层目录）), ...]"""
    exe_path = RELEASE_DIR / EXE_NAME
    if not exe_path.is_file():
        raise PackError(f"release exe 不存在: {exe_path}（先跑 npx tauri build --no-bundle）")

    detector_path = RELEASE_DIR / DETECT_EXE_NAME
    if not detector_path.is_file():
        raise PackError(
            f"Agent detector 不存在: {detector_path}（先构建 --release --bin pylon-detect）"
        )

    files: list[tuple[Path, str]] = [
        (exe_path, EXE_NAME),
        (detector_path, DETECT_EXE_NAME),
    ]

    # Tauri release 必带组件：WebView2Loader.dll（exe 启动必需，缺失 → 0xC0000135
    # DLL 缺失）；pylon-cli.exe（标准组件，命令行管理界面）。
    loader_path = RELEASE_DIR / "WebView2Loader.dll"
    if not loader_path.is_file():
        raise PackError(f"release WebView2Loader.dll 不存在: {loader_path}")
    files.append((loader_path, "WebView2Loader.dll"))

    cli_path = RELEASE_DIR / "pylon-cli.exe"
    if cli_path.is_file():
        files.append((cli_path, "pylon-cli.exe"))
    else:
        print("warn: 未找到 pylon-cli.exe，跳过该组件（不影响 GUI 启动）")

    resources_dir = RELEASE_DIR / "resources"
    if not resources_dir.is_dir():
        raise PackError(
            f"release resources 目录不存在: {resources_dir}。"
            "插件开发 SDK 是发行包必需资源。"
        )
    # 插件开发 SDK：完整离线分发包取自 dist-plugin-sdk/normal（2026-09-01 用户
    # 决定，不再使用 Tauri 拷贝的最小 runtime 子集——插件开发者需要 testing.js
    # 与 types/ 全套类型声明）。
    files.extend(collect_dev_sdk())
    for root, _dirs, names in os.walk(resources_dir):
        for name in names:
            full = Path(root) / name
            rel = full.relative_to(RELEASE_DIR).as_posix()
            if rel.startswith("resources/sdk/"):
                continue  # SDK 由 dist-plugin-sdk 全量提供，跳过 Tauri 最小集
            files.append((full, rel))

    # Hermes PortableGit runtime：默认排除（2026-08-31 用户决定——bash 已在标准路径
    # C:\Program Files\Git，发行包不再内置完整运行时；--with-runtime 可恢复）。
    if not with_runtime:
        files = [
            (source, rel)
            for source, rel in files
            if not rel.startswith("resources/runtime/")
        ]

    if with_runtime:
        # The Tauri resource copier normally places the runtime under
        # target/release/resources.  Keep a repository fallback for `--no-bundle`
        # layouts where that copy is skipped, while still requiring a complete
        # tree so a release can never silently omit Hermes' Bash dependency.
        packaged_runtime = RELEASE_DIR / "resources" / "runtime" / "git"
        runtime_source = packaged_runtime if hermes_runtime_is_complete(packaged_runtime) else HERMES_RUNTIME_TREE
        if not hermes_runtime_is_complete(runtime_source):
            raise PackError(
                "缺少完整的 Hermes PortableGit 运行时（resources/runtime/git）。"
                "请先运行 npm run prepare:hermes-runtime，再重新构建/打包。"
            )
        existing_paths = {rel for _src, rel in files}
        for runtime_rel in ["resources/runtime/portable-git.json", "resources/runtime/README.txt"]:
            source = HERMES_RUNTIME_DIR / Path(runtime_rel).name
            if runtime_rel not in existing_paths and source.is_file():
                files.append((source, runtime_rel))
                existing_paths.add(runtime_rel)
        # Add the binary tree only when Tauri did not already copy a *complete*
        # tree.  A partial target/release/resources copy must not shadow the
        # repository fallback.
        if not hermes_runtime_is_complete(packaged_runtime):
            files = [
                (source, rel)
                for source, rel in files
                if not rel.startswith("resources/runtime/git/")
            ]
            append_tree_files(files, runtime_source, "resources/runtime/git")

    for template_name in ["agents.example.yaml", "README.txt"]:
        src = TEMPLATE_DIR / template_name
        if not src.is_file():
            raise PackError(f"缺少 release 模板: {src}")
        files.append((src, template_name))

    # 发行包附带用户文档（2026-09-01 规则）：仓库根 README.md + docs/说明书/ 全量进入包内。
    readme_src = REPO_DIR / "README.md"
    if not readme_src.is_file():
        raise PackError(f"缺少发行包 README: {readme_src}")
    files.append((readme_src, "README.md"))
    manual_dir = REPO_DIR / "docs" / "说明书"
    if not manual_dir.is_dir():
        raise PackError(f"缺少发行包说明书目录: {manual_dir}")
    append_tree_files(files, manual_dir, "docs/说明书")

    bat_src = TEMPLATE_DIR / "tools" / "install-webview2.bat"
    if not bat_src.is_file():
        raise PackError(f"缺少 release 模板: {bat_src}")
    files.append((bat_src, "tools/install-webview2.bat"))

    # Optional user repair helper for older source-based Hermes installs.  It
    # is deliberately shipped as a script (never auto-executed): users choose
    # check/repair/restore from the menu, and every edit receives a backup.
    for repair_name in ("repair-hermes-acp.bat", "repair-hermes-acp.ps1"):
        repair_src = TEMPLATE_DIR / "tools" / repair_name
        if not repair_src.is_file():
            raise PackError(f"缺少 release 模板: {repair_src}")
        files.append((repair_src, f"tools/{repair_name}"))

    bootstrapper = TEMPLATE_DIR / "tools" / "MicrosoftEdgeWebview2Setup.exe"
    if without_webview2:
        if bootstrapper.is_file():
            print("warn: --without-webview2 已指定，忽略已存在的 WebView2 bootstrapper")
    else:
        if not bootstrapper.is_file():
            raise PackError(
                f"缺少 WebView2 bootstrapper: {bootstrapper}\n"
                "请将微软 Evergreen Bootstrapper 放到该路径，或显式 --without-webview2 降级打包。"
            )
        files.append((bootstrapper, "tools/MicrosoftEdgeWebview2Setup.exe"))

    return files


# ── staging / 压缩 ──

def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_staging(version: str, files: list[tuple[Path, str]]) -> Path:
    top_dir = f"pylon-{version}-win64"
    staging_root = OUT_ROOT / top_dir
    if staging_root.exists():
        shutil.rmtree(staging_root)
    staging_root.mkdir(parents=True)

    # 空 data/ + portable.flag：ZIP 解压后首次启动即请求 portable。
    (staging_root / "data").mkdir()
    (staging_root / "portable.flag").touch()

    for src, rel in files:
        dest = staging_root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            raise PackError(f"staging 目标已存在（重复文件）: {rel}")
        shutil.copy2(src, dest)
    return staging_root


def audit_staging(staging_root: Path, top_dir: str) -> None:
    for root, _dirs, names in os.walk(staging_root):
        for name in names:
            full = Path(root) / name
            rel = full.relative_to(staging_root).as_posix()
            reject_forbidden(rel)
            if is_text_file(full) and not is_hermes_runtime_payload(rel):
                scan_text_file(rel, full.read_text(encoding="utf-8", errors="strict"))


def build_manifest(
    top_dir: str,
    files: list[tuple[Path, str]],
    staging_root: Path,
    webview2_bootstrapper: bool,
) -> list[dict]:
    entries: list[dict] = []
    # 固定目录项也进入 manifest（portable.flag 与 data/ 目录）
    for rel in ["portable.flag"]:
        full = staging_root / rel
        entries.append(
            {"path": rel, "size": full.stat().st_size, "sha256": file_sha256(full)}
        )
    for src, rel in files:
        full = staging_root / rel
        entries.append(
            {"path": rel, "size": full.stat().st_size, "sha256": file_sha256(full)}
        )
    entries.sort(key=lambda item: item["path"])
    return entries


def write_zip(
    staging_root: Path,
    top_dir: str,
    version: str,
    files: list[tuple[Path, str]],
    webview2_bootstrapper: bool,
) -> None:
    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    zip_path = OUT_ROOT / f"{top_dir}.zip"
    if zip_path.exists():
        zip_path.unlink()

    entries = build_manifest(top_dir, files, staging_root, webview2_bootstrapper)

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        # 顶层目录条目
        zf.writestr(f"{top_dir}/", b"")
        zf.writestr(f"{top_dir}/data/", b"")
        for root, _dirs, names in os.walk(staging_root):
            for name in names:
                full = Path(root) / name
                rel = full.relative_to(staging_root).as_posix()
                zf.write(full, f"{top_dir}/{rel}")

    # hash 文件
    zip_sha256 = file_sha256(zip_path)
    sha_path = Path(str(zip_path) + ".sha256")
    sha_path.write_text(f"{zip_sha256}  {top_dir}.zip\n", encoding="utf-8")

    # manifest
    manifest = {
        "product": "Pylon",
        "version": version,
        "platform": "win64",
        "portable": True,
        "webview2Bootstrapper": webview2_bootstrapper,
        "files": entries,
    }
    manifest_path = OUT_ROOT / f"{top_dir}.manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"OK: {zip_path} ({zip_path.stat().st_size:,} bytes)")
    print(f"OK: {sha_path}")
    print(f"OK: {manifest_path}")
    for item in entries:
        print(f"{item['size']:>12,}  {item['path']}")


def verify_zip(zip_path: Path) -> None:
    if not zip_path.is_file():
        raise PackError(f"zip 不存在: {zip_path}")
    with zipfile.ZipFile(zip_path) as zf:
        bad = zf.testzip()
        if bad is not None:
            raise PackError(f"ZIP testzip 失败: {bad}")
        names = zf.namelist()
        if not names:
            raise PackError("ZIP 为空")
        top_dirs = {name.split("/", 1)[0] for name in names}
        top_dirs.discard("")
        if len(top_dirs) != 1:
            raise PackError(f"ZIP 顶层目录不唯一: {sorted(top_dirs)}")
        top_dir = top_dirs.pop()
        if not TOP_DIR_PATTERN.match(top_dir):
            raise PackError(f"ZIP 顶层目录名非法: {top_dir}")

        prefix = top_dir + "/"
        for name in names:
            if not name.startswith(prefix) or name == prefix:
                continue
            rel = name[len(prefix):]
            if name.endswith("/"):
                continue
            reject_forbidden(rel)
            if rel not in {"portable.flag"}:
                continue
        # 文本扫描（不扫描 exe/字体）
        for info in zf.infolist():
            if info.is_dir():
                continue
            rel = info.filename[len(prefix):]
            if is_text_file(Path(rel)) and not is_hermes_runtime_payload(rel):
                text = zf.read(info).decode("utf-8", errors="strict")
                scan_text_file(rel, text)

    manifest_path = Path(str(zip_path).removesuffix(".zip") + ".manifest.json")
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        with zipfile.ZipFile(zip_path) as zf:
            for entry in manifest.get("files", []):
                rel = entry["path"]
                info = zf.getinfo(f"{manifest['version'] and 'pylon-' + manifest['version'] + '-win64'}/{rel}")
                actual_size = info.file_size
                actual_hash = hashlib.sha256(zf.read(info)).hexdigest()
                if actual_size != entry.get("size") or actual_hash != entry.get("sha256"):
                    raise PackError(f"manifest 文件不匹配: {rel}")
        print(f"verify OK: manifest 与 ZIP 内容一致（{len(manifest.get('files', []))} 项）")
    else:
        print("warn: manifest 不存在，跳过 manifest 核对")

    print(f"verify OK: {zip_path}")


# ── main ──

def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--without-webview2",
        action="store_true",
        help="降级打包：不包含 WebView2 bootstrapper（manifest 记录 false）",
    )
    parser.add_argument(
        "--with-runtime",
        action="store_true",
        help="包含 Hermes PortableGit 运行时（默认排除——bash 已在标准路径 C:\\Program Files\\Git，2026-08-31 决定）",
    )
    parser.add_argument(
        "--verify-only",
        metavar="ZIP",
        help="仅审计已存在的 release ZIP，不重新打包",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])

    if args.verify_only:
        verify_zip(Path(args.verify_only))
        return 0

    version = resolve_version()
    top_dir = f"pylon-{version}-win64"
    files = collect_source_files(version, args.without_webview2, args.with_runtime)
    webview2_bootstrapper = not args.without_webview2

    staging_root = build_staging(version, files)
    try:
        audit_staging(staging_root, top_dir)
        write_zip(staging_root, top_dir, version, files, webview2_bootstrapper)
    finally:
        # 连续执行两次不混入旧 staging 内容
        if staging_root.exists():
            shutil.rmtree(staging_root)

    # 压缩后审计：生成物自身再过一遍 allowlist/hash
    verify_zip(OUT_ROOT / f"{top_dir}.zip")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
