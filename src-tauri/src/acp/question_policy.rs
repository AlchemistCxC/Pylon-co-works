//! Pure question request validation migrated from codeg `question.rs`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};

pub const MAX_QUESTIONS: usize = 4;
pub const MIN_OPTIONS: usize = 2;
pub const MAX_OPTIONS: usize = 4;
pub const MAX_HEADER_CHARS: usize = 12;
pub const MAX_QUESTION_TEXT_CHARS: usize = 4096;
static NEXT_QUESTION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionSpec {
    pub id: String,
    pub question: String,
    pub header: String,
    pub multi_select: bool,
    pub options: Vec<QuestionOption>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAnswerItem {
    pub question_id: String,
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionAnswer {
    #[serde(default)]
    pub answers: Vec<QuestionAnswerItem>,
    #[serde(default)]
    pub declined: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionAnsweredItem {
    pub question: String,
    pub header: String,
    pub multi_select: bool,
    pub selected: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionOutcome {
    #[serde(default)]
    pub answers: Vec<QuestionAnsweredItem>,
    #[serde(default)]
    pub declined: bool,
}

pub fn parse_questions(arguments: &Value) -> Result<Vec<QuestionSpec>, String> {
    let arr = arguments
        .get("questions")
        .and_then(Value::as_array)
        .ok_or("ask_user_question requires a `questions` array")?;
    if arr.is_empty() || arr.len() > MAX_QUESTIONS {
        return Err(format!("expected 1..={MAX_QUESTIONS} questions"));
    }
    arr.iter()
        .enumerate()
        .map(|(qi, q)| {
            let question = text(q, "question", qi)?;
            let header = text(q, "header", qi)?;
            if header.chars().count() > MAX_HEADER_CHARS {
                return Err(format!("questions[{qi}] header too long"));
            }
            if question.chars().count() > MAX_QUESTION_TEXT_CHARS {
                return Err(format!("questions[{qi}] question too long"));
            }
            let opts = q
                .get("options")
                .and_then(Value::as_array)
                .ok_or_else(|| format!("questions[{qi}] options missing"))?;
            if !(MIN_OPTIONS..=MAX_OPTIONS).contains(&opts.len()) {
                return Err(format!("questions[{qi}] invalid option count"));
            }
            let mut seen = HashSet::new();
            let options = opts
                .iter()
                .enumerate()
                .map(|(oi, o)| {
                    let label = o
                        .get("label")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .ok_or_else(|| format!("questions[{qi}].options[{oi}] label missing"))?
                        .to_string();
                    if !seen.insert(label.clone()) {
                        return Err(format!("questions[{qi}] duplicate option label"));
                    }
                    let description = o
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if label.chars().count() > MAX_QUESTION_TEXT_CHARS
                        || description.chars().count() > MAX_QUESTION_TEXT_CHARS
                    {
                        return Err(format!("questions[{qi}].options[{oi}] text too long"));
                    }
                    Ok(QuestionOption { label, description })
                })
                .collect::<Result<Vec<_>, String>>()?;
            let id = format!(
                "question-{}",
                NEXT_QUESTION_ID.fetch_add(1, Ordering::Relaxed)
            );
            Ok(QuestionSpec {
                id,
                question,
                header,
                multi_select: q
                    .get("multiSelect")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                options,
            })
        })
        .collect()
}

fn text(value: &Value, field: &str, index: usize) -> Result<String, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("questions[{index}] {field} missing"))
}

pub fn validate_specs(specs: &[QuestionSpec]) -> Result<(), String> {
    if specs.is_empty() || specs.len() > MAX_QUESTIONS {
        return Err(format!("expected 1..={MAX_QUESTIONS} questions"));
    }
    let mut ids = HashSet::new();
    for (i, spec) in specs.iter().enumerate() {
        if spec.id.trim().is_empty() || !ids.insert(&spec.id) {
            return Err(format!("questions[{i}] invalid id"));
        }
        if spec.question.trim().is_empty()
            || spec.question.chars().count() > MAX_QUESTION_TEXT_CHARS
        {
            return Err(format!("questions[{i}] invalid question"));
        }
        if spec.header.trim().is_empty() || spec.header.chars().count() > MAX_HEADER_CHARS {
            return Err(format!("questions[{i}] invalid header"));
        }
        if spec.options.len() > MAX_OPTIONS {
            return Err(format!("questions[{i}] too many options"));
        }
        let mut labels = HashSet::new();
        for option in &spec.options {
            if option.label.trim().is_empty()
                || !labels.insert(&option.label)
                || option.label.chars().count() > MAX_QUESTION_TEXT_CHARS
                || option.description.chars().count() > MAX_QUESTION_TEXT_CHARS
            {
                return Err(format!("questions[{i}] invalid option"));
            }
        }
    }
    Ok(())
}

/// Build the bounded answer payload used by the upstream question bridge.
/// Selection is capped while iterating, so hostile input cannot allocate an
/// unbounded intermediate vector.
pub fn build_outcome(questions: &[QuestionSpec], answer: &QuestionAnswer) -> QuestionOutcome {
    if answer.declined {
        return QuestionOutcome {
            answers: Vec::new(),
            declined: true,
        };
    }
    let answers = questions
        .iter()
        .filter_map(|spec| {
            let submitted = answer
                .answers
                .iter()
                .find(|item| item.question_id == spec.id)?;
            let cap = if spec.multi_select {
                spec.options.len() + 1
            } else {
                1
            };
            let mut selected = Vec::with_capacity(cap);
            for label in &submitted.labels {
                if selected.len() == cap {
                    break;
                }
                let trimmed = label.trim();
                if trimmed.is_empty() {
                    continue;
                }
                selected.push(trimmed.chars().take(MAX_QUESTION_TEXT_CHARS).collect());
            }
            (!selected.is_empty()).then_some(QuestionAnsweredItem {
                question: spec.question.clone(),
                header: spec.header.clone(),
                multi_select: spec.multi_select,
                selected,
            })
        })
        .collect();
    QuestionOutcome {
        answers,
        declined: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_and_mints_ids() {
        let parsed = parse_questions(&serde_json::json!({"questions":[{"question":"Which?","header":"Choice","options":[{"label":"A"},{"label":"B","description":"b"}]}]})).unwrap();
        assert_eq!(parsed.len(), 1);
        assert!(!parsed[0].id.is_empty());
        assert!(!parsed[0].multi_select);
    }
    #[test]
    fn rejects_duplicate_labels_and_invalid_counts() {
        assert!(parse_questions(&serde_json::json!({"questions":[]})).is_err());
        assert!(parse_questions(&serde_json::json!({"questions":[{"question":"q","header":"h","options":[{"label":"A"},{"label":"A"}]}]})).is_err());
    }
    #[test]
    fn validates_typed_specs_fail_closed() {
        let spec = QuestionSpec {
            id: "id".into(),
            question: "q".into(),
            header: "h".into(),
            multi_select: false,
            options: vec![],
        };
        assert!(validate_specs(&[spec]).is_ok());
        assert!(validate_specs(&[QuestionSpec {
            id: "".into(),
            question: "q".into(),
            header: "h".into(),
            multi_select: false,
            options: vec![]
        }])
        .is_err());
    }

    #[test]
    fn builds_bounded_outcome_and_preserves_decline() {
        let spec = QuestionSpec {
            id: "q1".into(),
            question: "Pick".into(),
            header: "Choice".into(),
            multi_select: false,
            options: vec![QuestionOption {
                label: "A".into(),
                description: String::new(),
            }],
        };
        let outcome = build_outcome(
            &[spec.clone()],
            &QuestionAnswer {
                answers: vec![QuestionAnswerItem {
                    question_id: "q1".into(),
                    labels: vec![" A ".into(), "B".into()],
                }],
                declined: false,
            },
        );
        assert_eq!(outcome.answers[0].selected, vec!["A"]);
        assert!(
            build_outcome(
                &[spec],
                &QuestionAnswer {
                    declined: true,
                    ..Default::default()
                }
            )
            .declined
        );
    }
}
