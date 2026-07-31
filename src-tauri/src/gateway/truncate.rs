//! 长回复切断（BE-B10-002 施工位）。
//!
//! 占位骨架：完整实现由 BE-B10-002 任务交付（超限分段 + 代码块 fence 保留 + 指示器）。

pub fn truncate_message(content: &str, max_length: usize) -> Vec<String> {
    if content.len() <= max_length {
        vec![content.to_string()]
    } else {
        vec![content.to_string()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_message_passes_through() {
        assert_eq!(truncate_message("hi", 4000), vec!["hi"]);
    }
}
