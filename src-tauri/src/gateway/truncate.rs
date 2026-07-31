//! 长回复切断（BE-B10-002）。
//!
//! 纯函数分段器：平台单条文本有上限（QQ = 4000 字符），agent 输出超限时切成多段。
//! 规则参考 Hermes `gateway/platforms/base.py::truncate_message`：
//! 超限才切、代码块 fence 保留、段尾 `(i/N)` 指示器、自然切点（换行 → 空格 → 硬切）。
//! 长度按 Unicode 字符（`char`）计，中文/emoji 均按 1，不按字节。
//! 无 IO、不依赖 tauri/AppState。

/// 分段指示器 `" (XX/XX)"` 的最大长度预算（`(100/100)` 恰好 10 字符）。
const INDICATOR_RESERVE: usize = 10;
/// 代码块收尾 fence（段尾补闭时使用，另起一行）。
const FENCE_CLOSE: &str = "\n```";

/// 将超长文本切成多段，每段（含指示器）不超过 `max_length` 字符。
///
/// - 不超限（或恰好等于上限）时原样返回单段；
/// - 切点落在 ``` 代码块内时，段尾补闭 fence，下段以原语言标签重开；
/// - 多段时每段末尾追加 `(i/N)` 分段指示器（预留 10 字符预算）；
/// - 切点优先换行 → 空格 → 硬切，避免切断单词/行；
/// - 长度按字符（`char`）计。
///
/// B10 deliver 发送管线尚未接线，暂与 route.rs/dedup.rs 占位文件一致标 allow；
/// 网关发送队列落地调用后移除。
#[allow(dead_code)]
pub fn truncate_message(content: &str, max_length: usize) -> Vec<String> {
    if char_len(content) <= max_length {
        return vec![content.to_string()];
    }

    let mut chunks: Vec<String> = Vec::new();
    let mut remaining = content;
    // 上段在代码块内结束时，这里记录语言标签（可能为空串），下段据此重开 fence。
    let mut carry_lang: Option<&str> = None;

    while !remaining.is_empty() {
        // 续接代码块时，段首补开 fence（保留原语言标签）。
        let prefix = match carry_lang {
            Some(lang) => format!("```{}\n", lang),
            None => String::new(),
        };

        // 预算：扣掉指示器、可能的段首重开 fence、段尾闭 fence 后，本段正文可用字符数。
        let headroom = {
            let h = max_length
                .saturating_sub(INDICATOR_RESERVE)
                .saturating_sub(char_len(&prefix))
                .saturating_sub(char_len(FENCE_CLOSE));
            if h < 1 {
                // 预算不足（max_length 过小）：退化为硬切，至少保证推进。
                (max_length / 2).max(1)
            } else {
                h
            }
        };

        // 余下内容（含段首 fence）能整体放进最后一段 → 收尾。
        if char_len(&prefix) + char_len(remaining) <= max_length.saturating_sub(INDICATOR_RESERVE) {
            chunks.push(prefix + remaining);
            break;
        }

        // 自然切点：优先换行，其次空格，最后硬切。
        let mut split_at = rfind_ascii_in_prefix(remaining, headroom, '\n').unwrap_or(0);
        if split_at < headroom / 2 {
            split_at = rfind_ascii_in_prefix(remaining, headroom, ' ').unwrap_or(0);
        }
        if split_at < 1 {
            split_at = headroom;
        }

        let body_end = char_to_byte_offset(remaining, split_at);
        let chunk_body = &remaining[..body_end];
        remaining = remaining[body_end..].trim_start();

        let mut full_chunk = prefix + chunk_body;

        // 逐行扫描本段正文，判断段末是否停在未闭合代码块内；若是，段尾闭 fence
        // 并把语言标签带到下一段重开。
        let mut in_code = carry_lang.is_some();
        let mut lang: &str = carry_lang.unwrap_or("");
        for line in chunk_body.lines() {
            let stripped = line.trim();
            if stripped.starts_with("```") {
                if in_code {
                    in_code = false;
                    lang = "";
                } else {
                    in_code = true;
                    let tag = stripped[3..].trim();
                    lang = tag.split_whitespace().next().unwrap_or("");
                }
            }
        }

        if in_code {
            full_chunk.push_str(FENCE_CLOSE);
            carry_lang = Some(lang);
        } else {
            carry_lang = None;
        }

        chunks.push(full_chunk);
    }

    // 多段时追加分段指示器 (i/N)。
    if chunks.len() > 1 {
        let total = chunks.len();
        for (i, chunk) in chunks.iter_mut().enumerate() {
            chunk.push_str(&format!(" ({}/{})", i + 1, total));
        }
    }

    chunks
}

/// 按字符（`char`）计数，中文/emoji 均按 1。
fn char_len(s: &str) -> usize {
    s.chars().count()
}

/// 取 `s` 的前 `n` 个字符（不足则全部），返回的子串必然落在字符边界上。
fn take_chars(s: &str, n: usize) -> &str {
    let end = char_to_byte_offset(s, n);
    &s[..end]
}

/// 将字符偏移转换为字节偏移（越界则取字符串末尾）。
fn char_to_byte_offset(s: &str, char_count: usize) -> usize {
    s.char_indices()
        .nth(char_count)
        .map(|(byte_idx, _)| byte_idx)
        .unwrap_or(s.len())
}

/// 在 `s` 的前 `limit` 个字符内查找最后一个 `needle`（ASCII 字符），
/// 返回其字符位置（而非字节位置，多字节字符前置时二者不等），找不到返回 `None`。
fn rfind_ascii_in_prefix(s: &str, limit: usize, needle: char) -> Option<usize> {
    let region = take_chars(s, limit);
    region
        .rfind(needle)
        .map(|byte_idx| region[..byte_idx].chars().count())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 剥掉段尾的 ` (i/N)` 指示器，返回纯正文（无指示器时原样返回）。
    fn strip_indicator(chunk: &str) -> &str {
        match chunk.rfind(" (") {
            Some(pos) => {
                let tail = &chunk[pos + 2..];
                if tail.contains('/') && tail.ends_with(')') {
                    &chunk[..pos]
                } else {
                    chunk
                }
            }
            None => chunk,
        }
    }

    #[test]
    fn short_message_passes_through() {
        assert_eq!(truncate_message("hi", 4000), vec!["hi"]);
    }

    #[test]
    fn empty_message_passes_through() {
        assert_eq!(truncate_message("", 4000), vec![""]);
    }

    #[test]
    fn exactly_max_length_not_split() {
        // 恰好等于上限：不分段、原样返回。
        let content = "a".repeat(50);
        assert_eq!(truncate_message(&content, 50), vec![content.clone()]);
        // 多字节字符按字符计：50 个中文字符 = 50 字符，恰好等于上限。
        let cn = "中文".repeat(25);
        assert_eq!(char_len(&cn), 50);
        assert_eq!(truncate_message(&cn, 50), vec![cn.clone()]);
        assert_eq!(cn, "中文".repeat(25));
    }

    #[test]
    fn long_message_split_into_chunks_within_limit() {
        let content = "The quick brown fox jumps over the lazy dog.\n".repeat(20);
        let max = 60;
        let chunks = truncate_message(&content, max);
        assert!(chunks.len() > 1, "应分成多段，实际 {}", chunks.len());
        for chunk in &chunks {
            assert!(
                char_len(chunk) <= max,
                "段长度 {} 超过上限 {}: {:?}",
                char_len(chunk),
                max,
                chunk
            );
        }
    }

    #[test]
    fn natural_split_prefers_newline_then_space() {
        // 无换行可切时退回空格切，不切断单词；输出可精确断言。
        let content = "aaaaaa bbbbbb cccccc\ndddddd";
        let expected = vec![
            "aaaaaa (1/4)",
            "bbbbbb (2/4)",
            "cccccc (3/4)",
            "dddddd (4/4)",
        ];
        assert_eq!(truncate_message(content, 20), expected);
    }

    #[test]
    fn split_inside_code_block_keeps_fence() {
        let code_line = "let answer = 42; // a very long comment that forces the split to land inside this code line without any doubt";
        let content = format!(
            "before\n```rust\n{}\nlet more = true;\n```\nafter",
            code_line
        );
        let max = 50;
        let chunks = truncate_message(&content, max);
        assert!(chunks.len() > 1, "应分成多段，实际 {}", chunks.len());

        for chunk in &chunks {
            assert!(
                char_len(chunk) <= max,
                "段长度 {} 超过上限 {}: {:?}",
                char_len(chunk),
                max,
                chunk
            );
        }

        // 切点落在代码块内：首段末尾补闭 fence。
        let first = strip_indicator(&chunks[0]);
        assert!(
            first.ends_with("\n```"),
            "首段应以闭 fence 结尾: {:?}",
            first
        );
        assert!(first.starts_with("before\n```rust\n"));

        // 次段用原语言标签重开 fence。
        let second = strip_indicator(&chunks[1]);
        assert!(
            second.starts_with("```rust\n"),
            "次段应以 ```rust 重开: {:?}",
            second
        );

        // 尾部内容完整保留，不因分段丢失。
        let last = strip_indicator(chunks.last().unwrap());
        assert!(
            last.contains("after"),
            "末段应含收尾文本: {:?}",
            last
        );
    }

    #[test]
    fn indicators_appended_in_order_and_content_preserved() {
        let content = "word ".repeat(50);
        let chunks = truncate_message(&content, 40);
        assert!(chunks.len() >= 2, "应分成多段，实际 {}", chunks.len());

        let total = chunks.len();
        for (i, chunk) in chunks.iter().enumerate() {
            let expected_suffix = format!(" ({}/{})", i + 1, total);
            assert!(
                chunk.ends_with(&expected_suffix),
                "第 {} 段应以 {:?} 结尾，实际: {:?}",
                i + 1,
                expected_suffix,
                chunk
            );
            // 剥掉指示器后是原文子串：分段不破坏内容、不改变顺序。
            let body = strip_indicator(chunk);
            assert!(
                content.contains(body),
                "段正文不是原文子串: {:?}",
                body
            );
        }
        // 末段正文应覆盖原文末尾（原文末尾是 "word " 带尾空格，需 trim 后比较）。
        let last = strip_indicator(chunks.last().unwrap());
        assert!(last.trim_end().ends_with("word"));
    }

    #[test]
    fn chinese_and_emoji_counted_as_single_char() {
        // 每个单元 2 个中文字符 + 1 个 emoji（4 字节）= 3 字符。
        let content = "中文🚀".repeat(30);
        assert_eq!(char_len(&content), 90);
        let max = 25;
        let chunks = truncate_message(&content, max);
        assert!(chunks.len() > 1, "应分成多段，实际 {}", chunks.len());

        for chunk in &chunks {
            assert!(
                char_len(chunk) <= max,
                "段长度 {} 超过上限 {}: {:?}",
                char_len(chunk),
                max,
                chunk
            );
            // 切点按字符对齐：剥掉指示器后必为原文子串（若切进多字节字符中间则不成立）。
            let body = strip_indicator(chunk);
            assert!(
                content.contains(body),
                "段正文不是原文子串: {:?}",
                body
            );
        }
    }
}
