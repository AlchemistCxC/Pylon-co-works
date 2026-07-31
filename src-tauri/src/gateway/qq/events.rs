//! QQ Bot 事件处理辅助函数（BE-B10-005）。
//!
//! 移植自 Prism `src/qq/events.rs`（对应 Hermes adapter 的
//! _process_attachments / _process_quoted_context / _parse_qq_timestamp）。
//! 纯函数：附件分类、@剥离、时间戳标准化、引用合并。无 IO、不依赖 tauri。
//! 占位期无消费者，与 route/truncate/dedup/auth 一致标 allow(dead_code)；
//! B10.1 骨架接线时必须移除。

use super::types::QqAttachment;

/// 附件处理结果
#[allow(dead_code)]
pub struct AttachmentResult {
    pub image_urls: Vec<String>,
    pub image_media_types: Vec<String>,
    pub voice_transcripts: Vec<String>,
    pub attachment_info: String,
}

/// 处理消息附件（图片、语音、文件等）
///
/// - image/* → image_urls + image_media_types
/// - audio/voice/silk → voice_transcripts（首版占位，QQ asr_refer_text 后续）
/// - video/* / 其他 → attachment_info 文本描述（带文件名）
/// - URL 为空的附件跳过
#[allow(dead_code)]
pub fn process_attachments(raw: &Option<Vec<QqAttachment>>) -> AttachmentResult {
    let mut image_urls = Vec::new();
    let mut image_media_types = Vec::new();
    let mut voice_transcripts = Vec::new();
    let mut other = Vec::new();

    if let Some(attachments) = raw {
        for att in attachments {
            let ct = att.content_type.as_deref().unwrap_or("");
            let url = att.url.as_deref().unwrap_or("");
            let filename = att.filename.as_deref().unwrap_or("");

            if url.is_empty() { continue; }

            if ct.starts_with("image/") {
                image_urls.push(url.to_string());
                image_media_types.push(ct.to_string());
            } else if ct.starts_with("audio/") || ct.contains("voice") || ct.contains("silk") {
                // 语音: 优先使用 QQ 自带的 asr_refer_text
                voice_transcripts.push("[Voice] [语音消息]".to_string());
            } else if ct.starts_with("video/") {
                other.push(format!("[video: {}]", if filename.is_empty() { ct } else { filename }));
            } else {
                other.push(format!("[file: {}]", if filename.is_empty() { ct } else { filename }));
            }
        }
    }

    AttachmentResult {
        image_urls,
        image_media_types,
        voice_transcripts,
        attachment_info: other.join("\n"),
    }
}

/// 标准化 QQ 时间戳 → Unix 秒（数字字符串兼容 f64/i64）。
#[allow(dead_code)]
pub fn parse_qq_timestamp(ts: &str) -> Option<f64> {
    ts.parse::<f64>().ok()
        .or_else(|| {
            ts.parse::<i64>().ok().map(|v| v as f64)
        })
}

/// 去掉消息中的 @bot 前缀（@ 后跟非空白 + 空白）。
#[allow(dead_code)]
pub fn strip_at_mention(content: &str) -> String {
    let trimmed = content.trim_start();
    // @ 开头后跟非空白字符 + 空白
    if let Some(rest) = trimmed.strip_prefix('@') {
        if let Some(space) = rest.find(char::is_whitespace) {
            return rest[space..].trim().to_string();
        }
    }
    content.trim().to_string()
}

/// 引用消息上下文字段
#[allow(dead_code)]
pub struct QuoteContext {
    pub quote_block: String,
    pub image_urls: Vec<String>,
    pub image_media_types: Vec<String>,
}

/// 处理 QQ 引用消息。
///
/// QQ Bot API v2 的引用消息在 message_type=103 时，引用内容在
/// msg_elements[0] 中。当前保留原始 event.d 由调用方自行处理，本函数预留接口。
#[allow(dead_code)]
pub fn process_quoted_context(_d: &serde_json::Value) -> QuoteContext {
    QuoteContext {
        quote_block: String::new(),
        image_urls: Vec::new(),
        image_media_types: Vec::new(),
    }
}

/// 合并引用消息到正文（引用在前，正文在后，双换行分隔）。
#[allow(dead_code)]
pub fn merge_quote_into(text: &str, quote: &str) -> String {
    if quote.is_empty() {
        text.to_string()
    } else if text.is_empty() {
        quote.to_string()
    } else {
        format!("{}\n\n{}", quote, text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attachment(url: &str, content_type: &str, filename: &str) -> QqAttachment {
        QqAttachment {
            url: (!url.is_empty()).then(|| url.to_string()),
            content_type: (!content_type.is_empty()).then(|| content_type.to_string()),
            filename: (!filename.is_empty()).then(|| filename.to_string()),
            file_type: None,
        }
    }

    #[test]
    fn attachments_are_classified_by_content_type() {
        let raw = Some(vec![
            attachment("https://cdn/img.png", "image/png", "pic.png"),
            attachment("https://cdn/voice.silk", "audio/silk", "v.silk"),
            attachment("https://cdn/clip.mp4", "video/mp4", "clip.mp4"),
            attachment("https://cdn/doc.pdf", "application/pdf", "doc.pdf"),
        ]);
        let result = process_attachments(&raw);
        assert_eq!(result.image_urls, vec!["https://cdn/img.png"]);
        assert_eq!(result.image_media_types, vec!["image/png"]);
        assert_eq!(result.voice_transcripts, vec!["[Voice] [语音消息]"]);
        assert!(result.attachment_info.contains("[video: clip.mp4]"));
        assert!(result.attachment_info.contains("[file: doc.pdf]"));
    }

    #[test]
    fn empty_url_attachments_are_skipped() {
        let raw = Some(vec![
            attachment("", "image/png", "broken.png"),
            attachment("https://cdn/ok.png", "image/png", "ok.png"),
        ]);
        let result = process_attachments(&raw);
        assert_eq!(result.image_urls, vec!["https://cdn/ok.png"]);
        assert_eq!(result.image_urls.len(), 1);
    }

    #[test]
    fn missing_attachments_yield_empty_result() {
        let result = process_attachments(&None);
        assert!(result.image_urls.is_empty());
        assert!(result.voice_transcripts.is_empty());
        assert!(result.attachment_info.is_empty());
    }

    #[test]
    fn unknown_voice_variant_detected_by_content_type_keyword() {
        // 语音判定只看 content_type（voice/silk 关键词），不看 filename
        let raw = Some(vec![attachment("https://cdn/v.silk", "application/silk", "v.silk")]);
        let result = process_attachments(&raw);
        assert_eq!(result.voice_transcripts, vec!["[Voice] [语音消息]"]);
        assert!(result.image_urls.is_empty());
        // filename 带 silk 但 content_type 不含关键词 → 归为文件
        let raw = Some(vec![attachment("https://cdn/v.silk", "application/octet-stream", "v.silk")]);
        let result = process_attachments(&raw);
        assert!(result.voice_transcripts.is_empty());
        assert!(result.attachment_info.contains("[file: v.silk]"));
    }

    #[test]
    fn strips_at_mention_prefix_only() {
        assert_eq!(strip_at_mention("@bot 你好世界"), "你好世界");
        assert_eq!(strip_at_mention("@pylon  hello"), "hello");
        assert_eq!(strip_at_mention("hello @bot"), "hello @bot");
        assert_eq!(strip_at_mention("  @bot x  "), "x");
    }

    #[test]
    fn parses_float_and_integer_timestamps() {
        assert_eq!(parse_qq_timestamp("1722500000.123"), Some(1722500000.123));
        assert_eq!(parse_qq_timestamp("1722500000"), Some(1722500000.0));
        assert_eq!(parse_qq_timestamp("not-a-time"), None);
    }

    #[test]
    fn merge_quote_prepends_quote_block() {
        assert_eq!(merge_quote_into("正文", ""), "正文");
        assert_eq!(merge_quote_into("", "引用"), "引用");
        assert_eq!(merge_quote_into("正文", "引用"), "引用\n\n正文");
    }

    #[test]
    fn quoted_context_is_an_unused_placeholder() {
        let context = process_quoted_context(&serde_json::json!({"d": {}}));
        assert!(context.quote_block.is_empty());
        assert!(context.image_urls.is_empty());
    }
}
