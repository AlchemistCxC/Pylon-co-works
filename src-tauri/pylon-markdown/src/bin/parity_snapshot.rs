//! markdown parity 快照导出（宿主 bin）。
//!
//! 用法：`cargo run -p pylon-markdown --bin parity_snapshot -- <corpus.json> <out.json>`
//!
//! 读 corpus 的 markdown 输入，用**纯内层**函数逐条产出渲染模型，写成稳定 JSON
//! （BTreeMap 键序，diff 友好）。vitest 侧的 `markdownComputeParity.test.ts` 消费这份
//! 产物做常驻 parity 门禁（产品路径 vs 本快照）。
//!
//! **高亮半已退役**（#241/ADR-0020）：高亮改由前端 Lezer 承担；corpus 里的 `highlight`
//! 组、TS 侧 dump（`parity/dump-ts.mjs`）与 `parity/diff.mjs` 一并退役。

use std::process::ExitCode;

use pylon_markdown::parser::parse_markdown;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let (corpus_path, out_path) = match (args.next(), args.next()) {
        (Some(corpus), Some(out)) => (corpus, out),
        _ => {
            eprintln!("用法: parity_snapshot <corpus.json> <out.json>");
            return ExitCode::FAILURE;
        }
    };

    let corpus_raw = match std::fs::read_to_string(&corpus_path) {
        Ok(raw) => raw,
        Err(error) => {
            eprintln!("读 corpus 失败 ({corpus_path}): {error}");
            return ExitCode::FAILURE;
        }
    };
    let corpus: Corpus = match serde_json::from_str(&corpus_raw) {
        Ok(corpus) => corpus,
        Err(error) => {
            eprintln!("corpus JSON 解析失败: {error}");
            return ExitCode::FAILURE;
        }
    };

    let mut markdown = Vec::new();
    for case in &corpus.markdown {
        let model = parse_markdown(&case.input);
        markdown.push(serde_json::json!({ "id": case.id, "model": model }));
    }

    let output = serde_json::json!({
        "generator": format!("pylon-markdown {} (parity_snapshot)", env!("CARGO_PKG_VERSION")),
        "markdown": markdown,
    });
    let rendered = match serde_json::to_string_pretty(&output) {
        Ok(rendered) => rendered,
        Err(error) => {
            eprintln!("快照序列化失败: {error}");
            return ExitCode::FAILURE;
        }
    };
    if let Err(error) = std::fs::write(&out_path, rendered + "\n") {
        eprintln!("写快照失败 ({out_path}): {error}");
        return ExitCode::FAILURE;
    }
    println!(
        "parity_snapshot: {} markdown → {out_path}",
        corpus.markdown.len()
    );
    ExitCode::SUCCESS
}

#[derive(serde::Deserialize)]
struct Corpus {
    markdown: Vec<MarkdownCase>,
}

#[derive(serde::Deserialize)]
struct MarkdownCase {
    id: String,
    input: String,
}
