//! #155 T3：dispatcher 跨窗口在途 run。只接收与 canonical fold 同判据的助手 delta。
//! 片段落盘后才发布到专用 draft seam；消息边界把整段提交为正式历史。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::Value;

use super::canonical_flush::{
    flush_committed_draft, flush_pending_canonical, PendingCanonicalPublish,
};
use super::log_canonical_ingest_error;
use crate::pet::PetState;
use crate::session::{
    draft_candidate, DraftCandidate, DraftCommitChunk, DraftFragmentInput, DurableSessionOwner,
    EventService, MessageService,
};

const MAX_CHUNKS: usize = 2000;
const MAX_BYTES: usize = 48 * 1024;
pub(super) const DRAFT_PERSIST_INTERVAL: std::time::Duration =
    std::time::Duration::from_millis(800);
const DRAFT_FRAGMENT_CHUNKS: usize = 16;

pub(crate) struct DraftRun {
    event_service: Option<Arc<EventService>>,
    owner: DurableSessionOwner,
    owner_key: String,
    draft_id: String,
    source: String,
    remote_session_id: String,
    generation: u64,
    candidate: DraftCandidate,
    bytes: usize,
    items: Vec<PendingCanonicalPublish>,
    chunks: Vec<DraftCommitChunk>,
    sanitized: Vec<Value>,
    persisted: usize,
    published: usize,
    fragment_index: i64,
}

impl Drop for DraftRun {
    fn drop(&mut self) {
        if let Some(service) = &self.event_service {
            service.abandon_draft(&self.owner_key, &self.draft_id);
        }
    }
}

impl DraftRun {
    fn accepts(&self, item: &PendingCanonicalPublish, candidate: &DraftCandidate) -> bool {
        self.owner == item.input.owner.clone().expect("candidate has owner")
            && self.source == item.input.source
            && self.remote_session_id == item.input.remote_session_id
            && self.generation == item.input.generation
            && self.candidate.event_type == candidate.event_type
            && self.candidate.identity == candidate.identity
            && self.items.len() < MAX_CHUNKS
            && self.bytes + candidate.raw_bytes <= MAX_BYTES
    }

    fn push(&mut self, item: PendingCanonicalPublish, bytes: usize) {
        self.bytes += bytes;
        self.chunks.push(DraftCommitChunk {
            raw_payload: item.input.payload.clone(),
            received_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        });
        self.items.push(item);
    }
}

pub(crate) struct DraftFlushContext<'a, R: tauri::Runtime> {
    pub window: &'a tauri::Window<R>,
    pub gateway: &'a crate::gateway::GatewayCore,
    pub update_channels: &'a crate::runtime::UpdateChannelMap,
    pub pet: &'a std::sync::Mutex<PetState>,
    pub client_generation: &'a AtomicU64,
    pub agent_id: &'a str,
    pub event_service: Option<&'a Arc<EventService>>,
    pub message_service: Option<&'a Arc<MessageService>>,
}

fn publish_draft_update<R: tauri::Runtime>(
    ctx: &DraftFlushContext<'_, R>,
    run: &DraftRun,
    index: usize,
) {
    let item = &run.items[index];
    if !item.decision.publish {
        return;
    }
    let mut payload = run.sanitized[index].clone();
    if let Value::Object(map) = &mut payload {
        map.insert("source".into(), Value::String(run.source.clone()));
        map.insert(
            "draftChunk".into(),
            serde_json::json!({
                "ownerKey": run.owner_key,
                "draftId": run.draft_id,
                "chunkIndex": index,
                "clientGeneration": run.generation,
            }),
        );
    }
    let channel = if ctx.gateway.is_platform_source(&run.source) {
        None
    } else {
        ctx.update_channels
            .lock()
            .ok()
            .and_then(|map| map.get(&run.source).cloned())
    };
    if let Some(channel) = channel {
        let frame =
            serde_json::json!({"event":crate::event_names::SESSION_UPDATE,"payload":payload});
        if let Err(error) = channel.send(frame) {
            tracing::warn!("draft channel update failed source={}: {error}", run.source);
        }
    } else {
        crate::emit_event_all(
            ctx.window,
            ctx.gateway,
            &run.source,
            crate::event_names::SESSION_UPDATE,
            payload,
        );
    }
}

async fn persist_through<R: tauri::Runtime>(
    ctx: &DraftFlushContext<'_, R>,
    run: &mut DraftRun,
    target: usize,
    publish: bool,
) -> bool {
    let Some(service) = ctx.event_service else {
        return false;
    };
    while run.persisted < target {
        let start = run.persisted;
        let mut end = start;
        let mut bytes = 2usize;
        while end < target && end - start < DRAFT_FRAGMENT_CHUNKS {
            let next = run.chunks[end].raw_payload.to_string().len();
            let required = next + usize::from(end > start);
            if end > start && bytes + required > MAX_BYTES {
                break;
            }
            bytes += required;
            end += 1;
        }
        let input = DraftFragmentInput {
            owner: run.owner.clone(),
            draft_id: run.draft_id.clone(),
            fragment_index: run.fragment_index,
            client_generation: run.generation as i64,
            remote_session_id: Some(run.remote_session_id.clone()),
            event_type: run.candidate.event_type.clone(),
            identity: run.candidate.identity.clone(),
            raw_payload: run.chunks[start..end]
                .iter()
                .map(|chunk| chunk.raw_payload.clone())
                .collect(),
            first_received_at: run.chunks[start].received_at.clone(),
        };
        let fragment = match service.append_draft_fragment(input).await {
            Ok(fragment) => fragment,
            Err(error) => {
                log_canonical_ingest_error(&error, ctx.agent_id, &run.source);
                return false;
            }
        };
        run.sanitized.extend(fragment.raw_payload);
        run.persisted = end;
        run.fragment_index += 1;
        for item in &mut run.items[start..end] {
            if let (Some((owner, snapshot)), Some(message_service)) =
                (item.session_state_to_persist.take(), ctx.message_service)
            {
                if let Err(error) = message_service
                    .set_session_state(owner, Some(item.input.remote_session_id.clone()), snapshot)
                    .await
                {
                    tracing::warn!(agent_id=ctx.agent_id, source=%item.input.source, error=%error, "draft session state persistence failed");
                }
            }
            for pet_event in item.pet_events.drain(..) {
                let _ = ctx.pet.lock().map(|mut state| pet_event.apply(&mut state));
            }
        }
    }
    if publish {
        for index in run.published..run.persisted {
            if ctx.client_generation.load(Ordering::Acquire) != run.generation {
                return false;
            }
            publish_draft_update(ctx, run, index);
        }
        run.published = run.persisted;
    }
    true
}

pub(crate) async fn publish_due_draft<R: tauri::Runtime>(
    ctx: &DraftFlushContext<'_, R>,
    run: &mut Option<DraftRun>,
) -> bool {
    let Some(run) = run.as_mut() else {
        return true;
    };
    let count = run.items.len();
    persist_through(ctx, run, count, true).await
}

pub(crate) async fn commit_open_draft<R: tauri::Runtime>(
    ctx: &DraftFlushContext<'_, R>,
    run: &mut Option<DraftRun>,
) -> bool {
    let Some(open) = run.as_mut() else {
        return true;
    };
    let count = open.items.len();
    if !persist_through(ctx, open, count, false).await {
        return false;
    }
    let mut open = run.take().expect("checked open run");
    let committed = flush_committed_draft(
        ctx.window,
        ctx.gateway,
        ctx.update_channels,
        ctx.pet,
        ctx.client_generation,
        ctx.agent_id,
        ctx.event_service,
        ctx.message_service,
        std::mem::take(&mut open.items),
        open.draft_id.clone(),
        std::mem::take(&mut open.chunks),
    )
    .await;
    committed
}

pub(crate) async fn absorb_window<R: tauri::Runtime>(
    ctx: &DraftFlushContext<'_, R>,
    run: &mut Option<DraftRun>,
    pending: Vec<PendingCanonicalPublish>,
) -> bool {
    let mut ordinary = Vec::new();
    for item in pending {
        let candidate = item
            .input
            .owner
            .as_ref()
            .and_then(|owner| draft_candidate(owner, item.input.payload.clone()));
        if let Some(candidate) = candidate {
            if !ordinary.is_empty()
                && !flush_pending_canonical(
                    ctx.window,
                    ctx.gateway,
                    ctx.update_channels,
                    ctx.pet,
                    ctx.client_generation,
                    ctx.agent_id,
                    ctx.event_service,
                    ctx.message_service,
                    std::mem::take(&mut ordinary),
                )
                .await
            {
                return false;
            }
            if run
                .as_ref()
                .is_some_and(|open| !open.accepts(&item, &candidate))
                && !commit_open_draft(ctx, run).await
            {
                return false;
            }
            if run.is_none() {
                let Some(owner) = item.input.owner.clone() else {
                    return false;
                };
                let Ok(owner_key) = owner.key() else {
                    return false;
                };
                let id = format!("{:032x}", rand::random::<u128>());
                *run = Some(DraftRun {
                    event_service: ctx.event_service.cloned(),
                    owner,
                    owner_key,
                    draft_id: id,
                    source: item.input.source.clone(),
                    remote_session_id: item.input.remote_session_id.clone(),
                    generation: item.input.generation,
                    candidate: candidate.clone(),
                    bytes: 0,
                    items: Vec::new(),
                    chunks: Vec::new(),
                    sanitized: Vec::new(),
                    persisted: 0,
                    published: 0,
                    fragment_index: 0,
                });
            }
            let open = run.as_mut().expect("run opened above");
            open.push(item, candidate.raw_bytes);
            // 首 chunk 立即登记占位，外部 evt_append 从这一刻起得到 draft_pending。
            // 展示等 800 ms 节流时钟或 16 条批次，且必须在片段落盘后。
            if open.persisted == 0 && !persist_through(ctx, open, 1, false).await {
                return false;
            }
            if open.items.len() - open.persisted >= DRAFT_FRAGMENT_CHUNKS {
                let target = open.items.len();
                if !persist_through(ctx, open, target, true).await {
                    return false;
                }
            }
        } else {
            if !commit_open_draft(ctx, run).await {
                return false;
            }
            ordinary.push(item);
        }
    }
    if !ordinary.is_empty() {
        flush_pending_canonical(
            ctx.window,
            ctx.gateway,
            ctx.update_channels,
            ctx.pet,
            ctx.client_generation,
            ctx.agent_id,
            ctx.event_service,
            ctx.message_service,
            ordinary,
        )
        .await
    } else {
        true
    }
}
