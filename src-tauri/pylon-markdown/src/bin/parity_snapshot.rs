//! WP4 parity 快照导出（宿主 bin）。
//!
//! 用法：`cargo run -p pylon-markdown --bin parity_snapshot -- <corpus.json> <out.json>`
//!
//! 读 corpus（markdown / highlight 两组输入），用**纯内层**函数逐条产出渲染模型与
//! 高亮行数组，写成稳定 JSON（BTreeMap 键序，diff 友好）。这份产物与 TS 侧 dump
//! （`parity/dump-ts.mjs` 产出）一起喂给 `parity/diff.mjs` 得差异清单；vitest 侧的
//! `markdownComputeParity.test.ts` 消费同一份产物做常驻 parity 门禁。

use std::process::ExitCode;

use pylon_markdown::highlight::highlight_block;
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

    let mut highlight = Vec::new();
    for case in &corpus.highlight {
        let lines = match highlight_block(&case.code, &case.language) {
            Ok(lines) => lines,
            Err(error) => {
                eprintln!("高亮失败 ({}): {error}", case.id);
                return ExitCode::FAILURE;
            }
        };
        highlight.push(serde_json::json!({
            "id": case.id,
            "language": case.language,
            // None = 引擎声明「不认识该语法」，与 TS 侧 null 同语义。
            "lines": lines,
            // 行数组出口不含行尾换行；扁平化对齐 starry 的「换行是无类文本」
            // 语义时需要知道原块是否以换行结尾（diff.mjs 与 vitest 门禁共用）。
            "endsWithNewline": case.code.ends_with('\n'),
        }));
    }

    let output = serde_json::json!({
        "generator": format!("pylon-markdown {} (parity_snapshot)", env!("CARGO_PKG_VERSION")),
        "markdown": markdown,
        "highlight": highlight,
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
        "parity_snapshot: {} markdown + {} highlight → {out_path}",
        corpus.markdown.len(),
        corpus.highlight.len()
    );
    ExitCode::SUCCESS
}

#[derive(serde::Deserialize)]
struct Corpus {
    markdown: Vec<MarkdownCase>,
    highlight: Vec<HighlightCase>,
}

#[derive(serde::Deserialize)]
struct MarkdownCase {
    id: String,
    input: String,
}

#[derive(serde::Deserialize)]
struct HighlightCase {
    id: String,
    language: String,
    code: String,
}
