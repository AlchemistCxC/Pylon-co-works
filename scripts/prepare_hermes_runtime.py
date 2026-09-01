"""Prepare the pinned PortableGit runtime used by Hermes on Windows.

The binary tree is intentionally not committed to the source repository.  A
portable release build runs this script, downloads the upstream self-extracting
PortableGit asset once, verifies its SHA-256, and stages the complete tree at
``src-tauri/resources/runtime/git``.  ``pack_release.py`` then copies that tree into the
release archive so end users do not need a separate Git installation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_DIR = SCRIPT_DIR.parent
# Keep the staged runtime beside the Tauri manifest.  Tauri resolves resource
# globs relative to `src-tauri`, so placing it at the repository root would
# make the release script see a tree that the app never packages.
RUNTIME_DIR = REPO_DIR / "src-tauri" / "resources" / "runtime"
RUNTIME_TREE = RUNTIME_DIR / "git"
METADATA_PATH = RUNTIME_DIR / "portable-git.json"
CACHE_DIR = REPO_DIR / ".cache" / "pylon" / "portable-git"


class PrepareError(RuntimeError):
    pass


def load_metadata() -> dict[str, str]:
    try:
        data = json.loads(METADATA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PrepareError(f"读取 PortableGit 元数据失败: {METADATA_PATH}: {exc}") from exc
    required = ("version", "asset", "url", "sha256")
    missing = [key for key in required if not str(data.get(key, "")).strip()]
    if missing:
        raise PrepareError(f"PortableGit 元数据缺少字段: {', '.join(missing)}")
    digest = str(data["sha256"]).lower().strip()
    if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        raise PrepareError("PortableGit 元数据中的 sha256 不是有效的 SHA-256")
    data["sha256"] = digest
    return data


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def runtime_bash_path(root: Path) -> Path | None:
    for relative in (Path("bin") / "bash.exe", Path("usr") / "bin" / "bash.exe"):
        candidate = root / relative
        if candidate.is_file():
            return candidate
    return None


def runtime_is_valid(root: Path) -> bool:
    bash = runtime_bash_path(root)
    if bash is None:
        return False
    # Keep this check aligned with the Rust preflight.  These are the commands
    # used by Hermes' local environment snapshot and file operations.
    usr_bin = root / "usr" / "bin"
    required = ("true.exe", "cat.exe", "mktemp.exe", "mv.exe", "awk.exe", "grep.exe")
    if any(not (usr_bin / name).is_file() for name in required):
        return False
    return any(
        (root / relative).is_file()
        for relative in (
            Path("usr") / "bin" / "msys-2.0.dll",
            Path("bin") / "msys-2.0.dll",
        )
    )


def download_asset(metadata: dict[str, str], cache_dir: Path) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    asset = cache_dir / metadata["asset"]
    if asset.is_file():
        actual = file_sha256(asset)
        if actual == metadata["sha256"]:
            print(f"PortableGit 缓存命中: {asset}")
            return asset
        print(f"warn: PortableGit 缓存 hash 不匹配，重新下载: {asset}")
        asset.unlink()

    partial = asset.with_suffix(asset.suffix + ".partial")
    if partial.exists():
        partial.unlink()
    request = urllib.request.Request(
        metadata["url"],
        headers={"User-Agent": "Pylon-PortableGit-Builder/1"},
    )
    print(f"下载 PortableGit {metadata['version']} ...")
    try:
        with urllib.request.urlopen(request, timeout=60) as response, partial.open("wb") as out:
            total = int(response.headers.get("Content-Length", "0") or 0)
            downloaded = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                downloaded += len(chunk)
                if total:
                    print(
                        f"\r  {downloaded / 1024 / 1024:.1f} / {total / 1024 / 1024:.1f} MB",
                        end="",
                        flush=True,
                    )
            if total:
                print()
        os.replace(partial, asset)
    except Exception:
        partial.unlink(missing_ok=True)
        raise

    actual = file_sha256(asset)
    if actual != metadata["sha256"]:
        asset.unlink(missing_ok=True)
        raise PrepareError(
            f"PortableGit SHA-256 校验失败: 期望 {metadata['sha256']}，实际 {actual}"
        )
    print(f"PortableGit 下载并校验完成: {asset}")
    return asset


def extract_asset(asset: Path, runtime_dir: Path) -> Path:
    if os.name != "nt":
        raise PrepareError(
            "PortableGit 自解压包只能在 Windows 目标机上准备；请在 Windows 上运行该脚本"
        )
    runtime_dir.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".portable-git-", dir=runtime_dir))
    try:
        target_arg = f"-o{staging}"
        print(f"解压 PortableGit 到临时目录: {staging}")
        result = subprocess.run(
            [str(asset), target_arg, "-y"],
            check=False,
            timeout=240,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if result.returncode != 0:
            detail = (result.stdout or "").strip()[-1000:]
            raise PrepareError(
                f"PortableGit 解压失败（退出码 {result.returncode}）{': ' + detail if detail else ''}"
            )

        # Different upstream builds have used both a flat tree and a single
        # top-level directory. Find the first valid tree without assuming one.
        possible = [staging, *[entry for entry in staging.iterdir() if entry.is_dir()]]
        for candidate in possible:
            if runtime_is_valid(candidate):
                return candidate
        raise PrepareError("解压完成但未找到完整的 PortableGit 运行时目录")
    except subprocess.TimeoutExpired as exc:
        shutil.rmtree(staging, ignore_errors=True)
        raise PrepareError("PortableGit 解压超过 240 秒") from exc
    except Exception:
        # On any extraction/validation failure the temporary tree is wholly
        # disposable. A successful tree is returned to the caller and cleaned
        # only after it has been moved into the final location.
        shutil.rmtree(staging, ignore_errors=True)
        raise


def install_tree(extracted: Path, runtime_dir: Path, force: bool) -> None:
    target = runtime_dir / "git"
    if target.exists() and runtime_is_valid(target) and not force:
        print(f"PortableGit 运行时已就绪: {target}")
        # The extraction staging directory is a sibling; it is cleaned by the
        # caller after this function returns.
        return
    if target.exists() and not force:
        raise PrepareError(
            f"发现不完整的 PortableGit 目录: {target}；如需替换请显式使用 --force"
        )
    if target.exists():
        shutil.rmtree(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    # Move rather than copy so a partially extracted tree is never visible at
    # the final path.
    shutil.move(str(extracted), str(target))
    if not runtime_is_valid(target):
        raise PrepareError(f"安装后的 PortableGit 运行时校验失败: {target}")
    print(f"PortableGit 运行时已就绪: {target}")


def prepare(force: bool, cache_dir: Path) -> None:
    metadata = load_metadata()
    if os.name != "nt":
        raise PrepareError(
            "当前发布目标是 win64；请在 Windows 上运行 prepare_hermes_runtime.py"
        )
    if runtime_is_valid(RUNTIME_TREE) and not force:
        print(f"PortableGit 运行时已就绪（跳过下载）: {RUNTIME_TREE}")
        return

    asset = download_asset(metadata, cache_dir)
    extracted = extract_asset(asset, RUNTIME_DIR)
    staging_parent = extracted.parent
    try:
        install_tree(extracted, RUNTIME_DIR, force)
    finally:
        # `extract_asset` may return the staging directory itself when the
        # upstream archive is flat. In that case its parent is RUNTIME_DIR;
        # deleting it would remove the metadata and the installed tree.
        if staging_parent == RUNTIME_DIR:
            # Flat archives use the staging directory itself as `extracted`;
            # clean that one child on an install error, but never remove the
            # resource directory that contains metadata/README files.
            if extracted.exists() and extracted != RUNTIME_DIR:
                shutil.rmtree(extracted, ignore_errors=True)
        elif staging_parent.exists():
            shutil.rmtree(staging_parent, ignore_errors=True)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--force",
        action="store_true",
        help="替换现有运行时（不完整目录默认拒绝覆盖）",
    )
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=CACHE_DIR,
        help=f"下载缓存目录（默认 {CACHE_DIR}）",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    try:
        prepare(args.force, args.cache_dir.resolve())
    except (OSError, PrepareError, subprocess.SubprocessError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
