"""pack_release.py 的离线审计测试（不触发真实构建/压缩大文件）。"""

import importlib.util
import json
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from typing import Any, cast

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "pack_release.py"
SPEC = importlib.util.spec_from_file_location("pack_release", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
# 动态加载的模块没有静态属性表：cast(Any) 让 pack.<name> 的读取与测试里的
# 模块级替身（OUT_ROOT / SRC_TAURI_DIR）都按测试惯用法通过类型检查。
pack = cast(Any, importlib.util.module_from_spec(SPEC))
SPEC.loader.exec_module(pack)


class VersionTests(unittest.TestCase):
    def test_three_version_files_are_consistent(self) -> None:
        # 三个版本源必须互相等。**不写死具体版本号**：字面量会在每次发版时假红，
        # 而且测不出本测试名承诺的"三处漂移"（旧写法只对着 "1.1.0" 断言，
        # 既从未比较过这三个文件，也在版本升到 1.6.0 后长期假红）。
        package = pack.parse_version_from_package_json()
        tauri = pack.parse_version_from_tauri_conf()
        cargo = pack.parse_version_from_cargo_toml()
        self.assertTrue(package)
        self.assertEqual(package, tauri)
        self.assertEqual(package, cargo)
        self.assertEqual(pack.resolve_version(), package)

    def test_cargo_toml_version_parser(self) -> None:
        # 与权威源（package.json）一致即可判定解析成功，不写死版本号。
        self.assertEqual(
            pack.parse_version_from_cargo_toml(),
            pack.parse_version_from_package_json(),
        )

    def test_cargo_toml_version_parser_reads_only_package_section(self) -> None:
        # [dependencies] 里的 version 不得被误当作包版本（合成输入，故可写死字面量）。
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "Cargo.toml").write_text(
                '[dependencies]\nversion = "9.9.9"\n\n[package]\nname = "x"\nversion = "2.3.4"\n',
                encoding="utf-8",
            )
            previous = pack.SRC_TAURI_DIR
            pack.SRC_TAURI_DIR = root
            try:
                self.assertEqual(pack.parse_version_from_cargo_toml(), "2.3.4")
            finally:
                pack.SRC_TAURI_DIR = previous

    def test_top_dir_pattern(self) -> None:
        self.assertIsNotNone(pack.TOP_DIR_PATTERN.match("pylon-1.1.0-win64"))
        self.assertIsNone(pack.TOP_DIR_PATTERN.match("pylon-1.1.0-win64/sub"))
        self.assertIsNone(pack.TOP_DIR_PATTERN.match("pylon-1.1.0"))


class AuditTests(unittest.TestCase):
    def test_scan_rejects_real_windows_absolute_path(self) -> None:
        with self.assertRaises(pack.PackError):
            pack.scan_text_file("agents.yaml", "exe: F:\\Agent\\peri.exe")

    def test_scan_allows_placeholder_path(self) -> None:
        pack.scan_text_file("agents.template.yaml", "exe: C:\\path\\to\\your-agent.exe")

    def test_scan_rejects_sensitive_value(self) -> None:
        with self.assertRaises(pack.PackError):
            pack.scan_text_file("config.yaml", "api_key: sk-123456")

    def test_scan_allows_sensitive_placeholder(self) -> None:
        pack.scan_text_file("config.example.yaml", "api_key: your-key")

    def test_reject_forbidden_names_and_suffixes(self) -> None:
        # agents.yaml 按位置区分（见 AgentsTemplatePackagingTests）；其余名字与
        # 后缀在任何位置都拒绝。
        for bad in ["resources/agents.yaml", "x.pdb", "a.rlib", "b.d", ".env", "x.env"]:
            with self.assertRaises(pack.PackError, msg=bad):
                pack.reject_forbidden(bad)

    def test_reject_forbidden_parts(self) -> None:
        for bad in ["src/main.rs", "src-tauri/src/lib.rs", "node_modules/x.js"]:
            with self.assertRaises(pack.PackError, msg=bad):
                pack.reject_forbidden(bad)

    def test_allows_expected_package_files(self) -> None:
        for ok in ["pylon.exe", "pylon-detect.exe", "resources/fonts/a.ttf", "tools/install-webview2.bat", "portable.flag"]:
            pack.reject_forbidden(ok)


class McpToolPackagingTests(unittest.TestCase):
    """自带的调试 MCP 服务器必须随发行包分发（2026-09-17 仓库主决定）。

    它与 app 是「外部进程 + WebView2 --remote-debugging-port」的松耦合关系，
    源码仓能 `cargo build`、拿到 zip 的人却拿不到——所以把 exe 与 README 一起打进
    `tools/webview2-mcp/`。本测试钉住三件事：收集路径、缺 exe 必须构建期报错
    （而不是拖到用户需要调试时才发现）、README 必须能过发行包的内容审计。
    """

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="pylon-mcp-pack-test-"))
        self.old_release = pack.MCP_RELEASE_DIR
        self.old_dir = pack.MCP_DIR

    def tearDown(self) -> None:
        pack.MCP_RELEASE_DIR = self.old_release
        pack.MCP_DIR = self.old_dir
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_exe_and_readme_land_under_tools_with_the_exe_name(self) -> None:
        release = self.tmp / "target" / "release"
        release.mkdir(parents=True)
        (release / pack.MCP_EXE_NAME).write_bytes(b"MZ-fake")
        docs = self.tmp / "docs"
        docs.mkdir()
        (docs / "README.md").write_text("# mcp", encoding="utf-8")
        pack.MCP_RELEASE_DIR = release
        pack.MCP_DIR = docs

        collected = dict(
            (rel, source) for source, rel in pack.collect_mcp_tool()
        )
        self.assertEqual(
            sorted(collected),
            [
                f"{pack.MCP_PACKAGE_DIR}/README.md",
                f"{pack.MCP_PACKAGE_DIR}/{pack.MCP_EXE_NAME}",
            ],
        )
        # 路径必须落在 tools/ 下：与随包脚本并列，且不进 src/ 这类被拒路径。
        for rel in collected:
            pack.reject_forbidden(rel)

    def test_missing_exe_fails_the_build_instead_of_shipping_silently(self) -> None:
        pack.MCP_RELEASE_DIR = self.tmp / "target" / "release"
        pack.MCP_DIR = pack.REPO_DIR / "tools" / "webview2-mcp"
        with self.assertRaises(pack.PackError) as raised:
            pack.collect_mcp_tool()
        # 报错要带出构建命令，否则拿到失败的人得回读脚本才知道怎么办。
        self.assertIn("--release", str(raised.exception))
        self.assertIn("tools/webview2-mcp", str(raised.exception))

    def test_missing_readme_fails_the_build(self) -> None:
        release = self.tmp / "target" / "release"
        release.mkdir(parents=True)
        (release / pack.MCP_EXE_NAME).write_bytes(b"MZ-fake")
        pack.MCP_RELEASE_DIR = release
        pack.MCP_DIR = self.tmp / "empty"
        with self.assertRaises(pack.PackError):
            pack.collect_mcp_tool()

    def test_the_shipped_readme_passes_the_release_audit(self) -> None:
        # README 是文本文件，会走 scan_text_file：里面不能有本机绝对路径或
        # 形如 `token: ...` 的敏感键，否则打包在审计阶段就会失败。
        readme = pack.REPO_DIR / "tools" / "webview2-mcp" / "README.md"
        self.assertTrue(readme.is_file())
        rel = f"{pack.MCP_PACKAGE_DIR}/README.md"
        pack.reject_forbidden(rel)
        pack.scan_text_file(rel, readme.read_text(encoding="utf-8"))


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
        pack.write_zip(staging, "pylon-1.1.0-win64", "1.1.0", files)
        zip_path = pack.OUT_ROOT / "pylon-1.1.0-win64.zip"
        self.assertTrue(zip_path.exists())
        self.assertTrue((pack.OUT_ROOT / "pylon-1.1.0-win64.zip.sha256").exists())
        manifest = pack.OUT_ROOT / "pylon-1.1.0-win64.manifest.json"
        self.assertTrue(manifest.exists())
        manifest_data = json.loads(manifest.read_text(encoding="utf-8"))
        # webview2Bootstrapper 字段已随 ADR-0014 移除，不得回潜。
        self.assertNotIn("webview2Bootstrapper", manifest_data)
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


class ManualPackagingTests(unittest.TestCase):
    """发行包必须打包 `docs/说明书/` **整个活目录**（2026-09-01 规则）。

    2026-09-15 仓库主决定：库内不再保留预打包的 `docs/说明书.zip`——它不会随文档更新、
    会变成陈旧副本；发行包改为每次从活目录全量收集。本测试把该约束钉住，防止有人改回
    “打一个预压包”或换成固定文件清单。
    """

    MANUAL_REL = "docs/说明书"

    def collected_manual(self) -> list[str]:
        manual = pack.REPO_DIR / "docs" / "说明书"
        files: list[tuple[Path, str]] = []
        pack.append_tree_files(files, manual, self.MANUAL_REL)
        return [rel for _src, rel in files]

    def test_every_manual_file_is_collected_recursively(self) -> None:
        manual = pack.REPO_DIR / "docs" / "说明书"
        self.assertTrue(manual.is_dir(), "发行包要求 docs/说明书/ 存在")
        expected = {
            f"{self.MANUAL_REL}/{path.relative_to(manual).as_posix()}"
            for path in manual.rglob("*")
            if path.is_file()
        }
        self.assertTrue(expected, "说明书目录不应为空")
        self.assertEqual(set(self.collected_manual()), expected)
        self.assertTrue(any(rel.endswith(".md") for rel in expected))

    def test_manual_is_packed_as_loose_files_not_a_prebuilt_archive(self) -> None:
        # 预压包不随文档更新 ⇒ 既不得在库内存在，也不得出现在收集结果里。
        self.assertFalse((pack.REPO_DIR / "docs" / "说明书.zip").exists())
        self.assertFalse([rel for rel in self.collected_manual() if rel.endswith(".zip")])

    def test_nested_subdirectories_are_walked(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "说明书"
            (root / "sub").mkdir(parents=True)
            (root / "a.md").write_text("a", encoding="utf-8")
            (root / "sub" / "b.md").write_text("b", encoding="utf-8")
            files: list[tuple[Path, str]] = []
            pack.append_tree_files(files, root, self.MANUAL_REL)
            self.assertEqual(
                sorted(rel for _src, rel in files),
                [f"{self.MANUAL_REL}/a.md", f"{self.MANUAL_REL}/sub/b.md"],
            )


class AgentsTemplatePackagingTests(unittest.TestCase):
    """发行包自带零 Agent 的 agents.yaml（#372，模板源 agents.template.yaml）。

    禁止名语义：`agents.yaml` 的禁令是防泄漏——不许把工作树的真实配置带进包。
    唯一放行点是包根 agents.yaml（打包器从 release 模板改名收取），任意子目录的
    同名文件仍拒绝；.env 没有放行点。模板内容必须零 Agent：#326 裁决占位 Agent
    必然启动失败，裸启动是空态 + 引导——模板若含 `exe:` 占位行等于把必然失败的
    Agent 重新带回首屏。
    """

    def test_agents_yaml_allowed_only_as_packaged_template_location(self) -> None:
        pack.reject_forbidden("agents.yaml")
        for bad in ["resources/agents.yaml", "tools/agents.yaml", "sub/dir/agents.yaml"]:
            with self.assertRaises(pack.PackError, msg=bad):
                pack.reject_forbidden(bad)
        for env_bad in [".env", "sub/.env", "agents.yaml/.env"]:
            with self.assertRaises(pack.PackError, msg=env_bad):
                pack.reject_forbidden(env_bad)

    def test_template_is_collected_under_packaged_name(self) -> None:
        # 仓库侧模板不占用被禁的名字，映射关系钉死：agents.template.yaml → 包根 agents.yaml。
        self.assertEqual(pack.AGENTS_TEMPLATE_SOURCE_NAME, "agents.template.yaml")
        self.assertEqual(pack.AGENTS_TEMPLATE_PACKAGED_NAME, "agents.yaml")

    def test_template_exists_is_zero_agent_and_replaces_example(self) -> None:
        template = pack.TEMPLATE_DIR / pack.AGENTS_TEMPLATE_SOURCE_NAME
        self.assertTrue(template.is_file(), "发行模板 agents.template.yaml 必须存在")
        self.assertFalse(
            (pack.TEMPLATE_DIR / "agents.example.yaml").exists(),
            "旧 agents.example.yaml 模板已由 agents.template.yaml 取代，不得回潜",
        )
        text = template.read_text(encoding="utf-8")
        self.assertIn("agents: {}", text)
        self.assertNotIn("exe:", text, "模板不得预置任何 Agent（#326：占位 exe 必然启动失败）")

    def test_template_passes_release_audit_under_packaged_name(self) -> None:
        template = pack.TEMPLATE_DIR / pack.AGENTS_TEMPLATE_SOURCE_NAME
        rel = pack.AGENTS_TEMPLATE_PACKAGED_NAME
        pack.reject_forbidden(rel)
        pack.scan_text_file(rel, template.read_text(encoding="utf-8"))


class WebView2BootstrapperTests(unittest.TestCase):
    """发行包不再内置 WebView2 bootstrapper（2026-09-19 仓库主决定，ADR-0014）。

    运行时按 Windows 自带处理；缺 Runtime 的机器由随包 tools/install-webview2.bat
    兜底联网安装（微软 fwlink，与 Tauri 安装器的 downloadBootstrapper 同源）。
    本测试钉住：随包 bat 必须能过发行内容审计——它现在携带 fwlink 下载链接，
    而 DRIVE_PATH_RE / SENSITIVE_KEY_RE 对 URL 与 %TEMP% 变量必须保持静默。
    """

    def test_shipped_fallback_bat_passes_release_audit(self) -> None:
        bat = pack.REPO_DIR / "resources" / "release" / "tools" / "install-webview2.bat"
        self.assertTrue(bat.is_file(), "WebView2 兜底安装脚本是发行包必需模板")
        rel = "tools/install-webview2.bat"
        pack.reject_forbidden(rel)
        pack.scan_text_file(rel, bat.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
