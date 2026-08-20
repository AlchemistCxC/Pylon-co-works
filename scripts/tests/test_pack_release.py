"""pack_release.py 的离线审计测试（不触发真实构建/压缩大文件）。"""

import importlib.util
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "pack_release.py"
SPEC = importlib.util.spec_from_file_location("pack_release", SCRIPT_PATH)
pack = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(pack)


class VersionTests(unittest.TestCase):
    def test_three_version_files_are_consistent(self) -> None:
        self.assertEqual(pack.resolve_version(), "1.1.0")

    def test_cargo_toml_version_parser(self) -> None:
        self.assertEqual(pack.parse_version_from_cargo_toml(), "1.1.0")

    def test_top_dir_pattern(self) -> None:
        self.assertIsNotNone(pack.TOP_DIR_PATTERN.match("pylon-1.1.0-win64"))
        self.assertIsNone(pack.TOP_DIR_PATTERN.match("pylon-1.1.0-win64/sub"))
        self.assertIsNone(pack.TOP_DIR_PATTERN.match("pylon-1.1.0"))


class AuditTests(unittest.TestCase):
    def test_scan_rejects_real_windows_absolute_path(self) -> None:
        with self.assertRaises(pack.PackError):
            pack.scan_text_file("agents.yaml", "exe: F:\\Agent\\peri.exe")

    def test_scan_allows_placeholder_path(self) -> None:
        pack.scan_text_file("agents.example.yaml", "exe: C:\\path\\to\\your-agent.exe")

    def test_scan_rejects_sensitive_value(self) -> None:
        with self.assertRaises(pack.PackError):
            pack.scan_text_file("config.yaml", "api_key: sk-123456")

    def test_scan_allows_sensitive_placeholder(self) -> None:
        pack.scan_text_file("config.example.yaml", "api_key: your-key")

    def test_reject_forbidden_names_and_suffixes(self) -> None:
        for bad in ["agents.yaml", "x.pdb", "a.rlib", "b.d", ".env", "x.env"]:
            with self.assertRaises(pack.PackError, msg=bad):
                pack.reject_forbidden(bad)

    def test_reject_forbidden_parts(self) -> None:
        for bad in ["src/main.rs", "src-tauri/src/lib.rs", "node_modules/x.js"]:
            with self.assertRaises(pack.PackError, msg=bad):
                pack.reject_forbidden(bad)

    def test_allows_expected_package_files(self) -> None:
        for ok in ["pylon.exe", "pylon-detect.exe", "resources/fonts/a.ttf", "tools/install-webview2.bat", "portable.flag"]:
            pack.reject_forbidden(ok)


class StagingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="pylon-pack-test-"))
        self.old_out = pack.OUT_ROOT
        pack.OUT_ROOT = self.tmp / "release"

    def tearDown(self) -> None:
        pack.OUT_ROOT = self.old_out
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_build_staging_creates_portable_layout_and_audits(self) -> None:
        src = self.tmp / "fake.txt"
        src.write_text("hello", encoding="utf-8")
        staging = pack.build_staging("1.1.0", [(src, "fake.txt")])
        self.assertTrue((staging / "portable.flag").exists())
        self.assertTrue((staging / "data").is_dir())
        self.assertTrue((staging / "fake.txt").is_file())
        pack.audit_staging(staging, "pylon-1.1.0-win64")

    def test_write_zip_has_single_top_dir_and_manifest_hash(self) -> None:
        src = self.tmp / "fake.txt"
        src.write_text("hello", encoding="utf-8")
        files = [(src, "fake.txt")]
        staging = pack.build_staging("1.1.0", files)
        pack.write_zip(staging, "pylon-1.1.0-win64", "1.1.0", files, False)
        zip_path = pack.OUT_ROOT / "pylon-1.1.0-win64.zip"
        self.assertTrue(zip_path.exists())
        self.assertTrue((pack.OUT_ROOT / "pylon-1.1.0-win64.zip.sha256").exists())
        manifest = pack.OUT_ROOT / "pylon-1.1.0-win64.manifest.json"
        self.assertTrue(manifest.exists())
        with zipfile.ZipFile(zip_path) as zf:
            names = zf.namelist()
            self.assertIn("pylon-1.1.0-win64/", names)
            self.assertIn("pylon-1.1.0-win64/data/", names)
            self.assertIn("pylon-1.1.0-win64/portable.flag", names)
            self.assertIn("pylon-1.1.0-win64/fake.txt", names)
        pack.verify_zip(zip_path)

    def test_staging_is_cleaned_between_runs(self) -> None:
        src = self.tmp / "old.txt"
        src.write_text("old", encoding="utf-8")
        pack.build_staging("1.1.0", [(src, "old.txt")])
        pack.build_staging("1.1.0", [(src, "new.txt")])
        staging = pack.OUT_ROOT / "pylon-1.1.0-win64"
        self.assertTrue((staging / "new.txt").exists())
        self.assertFalse((staging / "old.txt").exists())


if __name__ == "__main__":
    unittest.main()
