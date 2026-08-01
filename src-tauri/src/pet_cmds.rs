//! 宠物状态命令（R1 拆分自 lib.rs；行为零变化）。

use crate::error::PylonError;
use crate::pet;
use crate::AppState;
use std::sync::atomic::Ordering;
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
pub(crate) async fn persist_pet_async(state: &AppState, app: &tauri::AppHandle) {
    let path = match pet_persist_path(app) {
        Ok(path) => path,
        Err(error) => {
            log::warn!("resolve pet persist path failed: {error}");
            return;
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
                return;
            }
        };
        match pet::serialize_state(&pet) {
            Ok(json) => json,
            Err(error) => {
                log::warn!("serialize pet state failed: {error}");
                return;
            }
        }
    };
    match tokio::task::spawn_blocking(move || pet::write_json_atomic(&path, &json)).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => log::warn!("persist pet state failed: {error}"),
        Err(error) => log::warn!("persist pet task failed: {error}"),
    }
}

/// get_pet 轮询路径的写盘节流间隔（P3）：宠物状态只在有意义的变更时变化，
/// 12s 轮询无条件全量序列化 + 落盘是纯浪费。状态突变路径（pet_action）与
/// 退出兜底仍无条件写盘，节流只降低轮询路径频率，最坏丢失 <60s 的变更。
const PET_PERSIST_THROTTLE_MS: u64 = 60_000;

#[tauri::command]
pub(crate) async fn get_pet(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, PylonError> {
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
    // P3：节流写盘——距上次落盘不足 60s 的轮询不再序列化 + 写盘
    // （原子计数无需 pet 锁；R4：Timestamp 直取 u64 消除 parse 往返）。
    let now_ms = crate::time::Timestamp::now().as_u64();
    let last_persist = state.pet_last_persist_ms.load(Ordering::Acquire);
    if now_ms.saturating_sub(last_persist) >= PET_PERSIST_THROTTLE_MS {
        persist_pet_async(&state, &app).await;
        state.pet_last_persist_ms.store(now_ms, Ordering::Release);
    }
    Ok(value)
}

#[tauri::command]
pub(crate) async fn pet_action(app: tauri::AppHandle, state: tauri::State<'_, AppState>, action: String, value: Option<String>) -> Result<serde_json::Value, PylonError> {
    // R6a：pet 锁守卫限定在显式块内（块结束即释放，std MutexGuard 不可跨 await）。
    let result = {
        let mut pet = state.pet.lock().map_err(|e| e.to_string())?;
        let mut sleepy_result: Option<bool> = None;
        match action.as_str() {
            "poke" => { pet::on_poke(&mut pet); }
            "feed" => { pet::on_feed(&mut pet); }
            "play" => { pet::on_play(&mut pet); }
            "rename" => { if let Some(v) = value { pet::rename(&mut pet, &v); } }
            "daily" => { pet::daily_visit(&mut pet); }
            "sleepy" => { sleepy_result = Some(pet::check_sleepy(&mut pet)); }
            "nostalgia" => { pet::recall_memory(&mut pet); }
            // M10：装扮装备/卸下（equip 失败返回原因，不 panic）
            "equip" => {
                let item_id = value.ok_or_else(|| "equip requires item id".to_string())?;
                pet::equip(&mut pet, &item_id).map_err(|error| PylonError::Protocol(error))?;
            }
            "unequip" => { pet::unequip(&mut pet); }
            "restore" => {
                let raw = value.ok_or_else(|| "restore requires pet state".to_string())?;
                let saved = serde_json::from_str(&raw).map_err(|error| format!("invalid pet state: {error}"))?;
                pet::restore(&mut pet, saved);
            }
            _ => { return Err(PylonError::Protocol(format!("unknown action: {}", action))); }
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
    // R6a：状态突变路径无条件写盘，但磁盘 IO 移出 pet 锁（锁外 persist_pet_async）。
    persist_pet_async(&state, &app).await;
    Ok(result)
}
