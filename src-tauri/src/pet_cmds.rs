//! 宠物状态命令（R1 拆分自 lib.rs；行为零变化）。

use crate::error::PylonError;
use crate::pet;
use crate::AppState;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::Manager;

/// 宠物状态落盘路径：app_config_dir/pylon-pet.json。
pub(crate) fn pet_persist_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("pylon-pet.json"))
}

/// 尽力持久化（同步路径：Exit 兜底）：路径解析或写盘失败只 warn，不阻断主流程。
pub(crate) fn persist_pet_if_possible(app: &tauri::AppHandle, pet: &pet::PetState) {
    match pet_persist_path(app) {
        Ok(path) => {
            if let Err(error) = pet::save_to_file(pet, &path) {
                log::warn!("persist pet state failed: {error}");
            }
        }
        Err(error) => log::warn!("resolve pet persist path failed: {error}"),
    }
}

/// 命令路径的写盘（R6a：移出 pet 锁内 IO）。
/// 写序由 `pet_write_lock`（tokio Mutex）保证：序列化在临界区内执行，后写状态必
/// ≥ 先写状态（无乱序覆盖）；pet 锁只做内存序列化（微秒级）；fs 写经
/// `spawn_blocking` 在阻塞线程池执行，不阻塞 async 运行时。
/// 失败只 warn（尽力持久化语义，与同步路径一致）。
/// O20：返回是否真正写盘成功——失败时调用方不得刷新节流时间戳（可重试）。
pub(crate) async fn persist_pet_async(state: &AppState, app: &tauri::AppHandle) -> bool {
    let path = match pet_persist_path(app) {
        Ok(path) => path,
        Err(error) => {
            log::warn!("resolve pet persist path failed: {error}");
            return false;
        }
    };
    let _write_guard = state.pet_write_lock.lock().await;
    // 显式块限定 pet 锁守卫作用域：序列化（内存，微秒级）后立即释放，
    // 绝不把 std MutexGuard 带过 spawn_blocking await（跨 await 不 Send）。
    let json = {
        let pet = match state.pet.lock() {
            Ok(pet) => pet,
            Err(_) => {
                log::warn!("pet lock poisoned; skip persist");
                return false;
            }
        };
        match pet::serialize_state(&pet) {
            Ok(json) => json,
            Err(error) => {
                log::warn!("serialize pet state failed: {error}");
                return false;
            }
        }
    };
    match tokio::task::spawn_blocking(move || pet::write_json_atomic(&path, &json)).await {
        Ok(Ok(())) => true,
        Ok(Err(error)) => {
            log::warn!("persist pet state failed: {error}");
            false
        }
        Err(error) => {
            log::warn!("persist pet task failed: {error}");
            false
        }
    }
}

/// 统一刷新语义（O21）：写盘成功后刷新 `pet_last_persist_ms`——get_pet 轮询与
/// pet_action 突变共用，消除 pet_action 写盘不刷新时间戳导致的活跃期冗余写
/// （写盘后 get_pet 在 60s 节流窗口外仍会再次序列化 + 落盘）。
/// O20：persist 失败不 store（false 时不更新时间戳）——写失败可重试。
async fn persist_and_mark(state: &AppState, app: &tauri::AppHandle, now_ms: u64) -> bool {
    if persist_pet_async(state, app).await {
        state.pet_last_persist_ms.store(now_ms, Ordering::Release);
        true
    } else {
        false
    }
}

/// get_pet 轮询路径的写盘节流间隔（P3 语义保留为 R17 re-arm 兜底）：宠物状态
/// 只在有意义的变更时变化；距上次成功落盘 ≥60s 时重触发一次 coalescing 写盘，
/// 保证最坏丢失窗口 ≤60s（写失败也由该窗口重试）。
const PET_PERSIST_THROTTLE_MS: u64 = 60_000;

/// R17：coalescing 落盘后台任务的 debounce 间隔——唤醒后合并 2s 内的连续突变。
const PET_FLUSH_DEBOUNCE_MS: u64 = 2_000;

/// 节流判定：距上次写盘不足 throttle_ms 视为在节流窗口内，不再落盘。
fn within_throttle(last_persist_ms: u64, now_ms: u64, throttle_ms: u64) -> bool {
    now_ms.saturating_sub(last_persist_ms) < throttle_ms
}

// R17：进程级单例（宠物全局唯一）——状态突变路径不直接写盘，只置 dirty 并
// 唤醒后台任务；后台任务 debounce 后统一落盘（coalescing）。
// 替代"写锁 + 节流 + spawn_blocking"三件套的命令路径组合：写盘时机从"每次
// 突变立即写"变为"debounce 后合并写"，最坏丢失窗口仍 ≤60s（re-arm 兜底）。
static PET_DIRTY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static PET_NOTIFY: tokio::sync::Notify = tokio::sync::Notify::const_new();
static PET_FLUSH_SPAWNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 状态突变路径标记：置 dirty 并唤醒后台落盘任务（写盘时机由 debounce 决定）。
fn mark_dirty() {
    PET_DIRTY.store(true, Ordering::Release);
    PET_NOTIFY.notify_waiters();
}

/// Exit 兜底的有界 drain（lib.rs RunEvent::Exit 调用）：清 dirty 后直接同步
/// 持久化，后台任务不再重复写盘（在途写盘不受影响，与 R6a 尽力语义一致）。
pub(crate) fn drain_pet_dirty() {
    PET_DIRTY.store(false, Ordering::Release);
}

/// debounce 静默判定：消费 dirty 标志——置位说明唤醒窗口内仍有待写突变。
fn consume_dirty() -> bool {
    PET_DIRTY.swap(false, Ordering::AcqRel)
}

/// lazily spawn（get_pet 首次调用）：进程生命周期内只启动一个后台任务。
fn ensure_flush_task(app: &tauri::AppHandle) {
    if PET_FLUSH_SPAWNED.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    tokio::spawn(async move { pet_flush_loop(app).await });
}

/// 后台 coalescing 落盘任务：唤醒后 debounce 2s；期间新突变再次置 dirty 则
/// 继续合并；dirty 静默后写盘一次。写失败恢复 dirty 并回到等待（下次唤醒
/// ≤60s：新突变 / get_pet re-arm），避免失败热循环刷日志。
async fn pet_flush_loop(app: tauri::AppHandle) {
    loop {
        PET_NOTIFY.notified().await;
        loop {
            tokio::time::sleep(Duration::from_millis(PET_FLUSH_DEBOUNCE_MS)).await;
            if !consume_dirty() {
                break;
            }
            let state = app.state::<AppState>();
            let now_ms = crate::time::Timestamp::now().as_u64();
            if !persist_and_mark(&state, &app, now_ms).await {
                PET_DIRTY.store(true, Ordering::Release);
                break;
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn get_pet(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    // R6a：pet 锁守卫限定在显式块内——块结束即释放（std MutexGuard 不可跨
    // await 保持 Send；显式块作用域比 drop(pet) 更可靠），下方 await 全部锁外。
    let value = {
        let mut pet = state.pet.lock().map_err(|e| e.to_string())?;
        pet::daily_visit(&mut pet);
        // 自动入睡：轮询时检查（首字后 30s 无互动 → sleepy），幂等
        pet::check_sleepy(&mut pet);
        // M6：主动说话（需求危机/捏朋友完成）
        pet::poll_voice(&mut pet);
        let msg = pet.msg.take();
        let mut value = serde_json::to_value(pet::view(&pet)).map_err(|e| e.to_string())?;
        if let Some(message) = msg {
            value["msg"] = serde_json::Value::String(message);
        }
        value
    };
    // R17：get_pet 首次调用 lazily spawn coalescing 后台落盘任务（进程级单例）。
    ensure_flush_task(&app);
    // P3 节流语义保留为 re-arm 兜底：距上次成功落盘 ≥60s 时 mark_dirty 强制
    // 一次 flush——最坏丢失窗口 ≤60s；写失败时间戳不刷新，下一轮 re-arm 重试。
    let now_ms = crate::time::Timestamp::now().as_u64();
    let last_persist = state.pet_last_persist_ms.load(Ordering::Acquire);
    if !within_throttle(last_persist, now_ms, PET_PERSIST_THROTTLE_MS) {
        mark_dirty();
    }
    Ok(value)
}

#[tauri::command]
pub(crate) async fn pet_action(
    _app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    action: String,
    value: Option<String>,
) -> Result<serde_json::Value, PylonError> {
    // R6a：pet 锁守卫限定在显式块内（块结束即释放，std MutexGuard 不可跨 await）。
    let result = {
        let mut pet = state.pet.lock().map_err(|e| e.to_string())?;
        let mut sleepy_result: Option<bool> = None;
        match action.as_str() {
            "poke" => {
                pet::on_poke(&mut pet);
            }
            "feed" => {
                pet::on_feed(&mut pet);
            }
            "play" => {
                pet::on_play(&mut pet);
            }
            "rename" => {
                if let Some(v) = value {
                    pet::rename(&mut pet, &v);
                }
            }
            "daily" => {
                pet::daily_visit(&mut pet);
            }
            "sleepy" => {
                sleepy_result = Some(pet::check_sleepy(&mut pet));
            }
            "nostalgia" => {
                pet::recall_memory(&mut pet);
            }
            // M10：装扮装备/卸下（equip 失败返回原因，不 panic）
            "equip" => {
                let item_id = value.ok_or_else(|| "equip requires item id".to_string())?;
                pet::equip(&mut pet, &item_id).map_err(PylonError::Protocol)?;
            }
            "unequip" => {
                pet::unequip(&mut pet);
            }
            "restore" => {
                let raw = value.ok_or_else(|| "restore requires pet state".to_string())?;
                let saved = serde_json::from_str(&raw)
                    .map_err(|error| format!("invalid pet state: {error}"))?;
                pet::restore(&mut pet, saved);
            }
            _ => {
                return Err(PylonError::Protocol(format!("unknown action: {}", action)));
            }
        }
        let msg = pet.msg.take();
        let mut result = serde_json::to_value(pet::view(&pet)).map_err(|e| e.to_string())?;
        if let Some(sleepy) = sleepy_result {
            // 透传 check_sleepy 结果，前端据此切换睡眠动画/状态
            result["sleepy"] = serde_json::Value::Bool(sleepy);
        }
        if let Some(message) = msg {
            result["msg"] = serde_json::Value::String(message);
        }
        result
    };
    // R6a：状态突变路径不直接写盘（磁盘 IO 全量移出 pet 锁 + 命令路径）。
    // R17：统一 mark_dirty——poke/play 连点等高频突变由后台任务 debounce 合并
    // 为一次写盘（O18/O19 的命令路径节流/CAS 语义被 coalescing 任务承担）；
    // 写失败不刷新时间戳（O20），由 60s re-arm 兜底重试。
    mark_dirty();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn throttle_window_covers_only_sub_throttle_elapsed() {
        assert!(within_throttle(1_000, 5_999, 5_000));
        assert!(!within_throttle(1_000, 6_000, 5_000));
        assert!(within_throttle(0, 0, 5_000));
        assert!(within_throttle(10_000, 1_000, 5_000));
    }

    #[test]
    fn dirty_flag_mark_consume_and_drain_round_trips() {
        PET_DIRTY.store(false, Ordering::Release);
        assert!(!consume_dirty());
        mark_dirty();
        assert!(PET_DIRTY.load(Ordering::Acquire));
        assert!(consume_dirty());
        assert!(!consume_dirty());
        mark_dirty();
        drain_pet_dirty();
        assert!(!PET_DIRTY.load(Ordering::Acquire));
        PET_DIRTY.store(false, Ordering::Release);
    }

    #[test]
    fn rearm_fires_only_after_throttle_elapsed() {
        // 距上次成功落盘 <60s → 在节流窗口内，get_pet 不 re-arm
        assert!(within_throttle(1_000, 60_999, PET_PERSIST_THROTTLE_MS));
        // ≥60s → 窗口已过，get_pet 触发 mark_dirty
        assert!(!within_throttle(1_000, 61_000, PET_PERSIST_THROTTLE_MS));
    }
}
