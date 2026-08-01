//! 宠物状态命令（R1 拆分自 lib.rs；行为零变化）。

use crate::error::PylonError;
use crate::pet;
use crate::runtime_log;
use crate::AppState;
use std::sync::atomic::Ordering;
use tauri::Manager;

/// 宠物状态落盘路径：app_config_dir/pylon-pet.json。
pub(crate) fn pet_persist_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("pylon-pet.json"))
}

/// 尽力持久化：路径解析或写盘失败只 warn，不阻断主流程。
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

/// get_pet 轮询路径的写盘节流间隔（P3）：宠物状态只在有意义的变更时变化，
/// 12s 轮询无条件全量序列化 + 落盘是纯浪费。状态突变路径（pet_action）与
/// 退出兜底仍无条件写盘，节流只降低轮询路径频率，最坏丢失 <60s 的变更。
const PET_PERSIST_THROTTLE_MS: u64 = 60_000;

#[tauri::command]
pub(crate) async fn get_pet(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, PylonError> {
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
    // P3：节流写盘——距上次落盘不足 60s 的轮询不再序列化 + 写盘。
    let now_ms: u64 = runtime_log::timestamp().parse().unwrap_or(0);
    let last_persist = state.pet_last_persist_ms.load(Ordering::Acquire);
    if now_ms.saturating_sub(last_persist) >= PET_PERSIST_THROTTLE_MS {
        persist_pet_if_possible(&app, &pet);
        state.pet_last_persist_ms.store(now_ms, Ordering::Release);
    }
    Ok(value)
}

#[tauri::command]
pub(crate) async fn pet_action(app: tauri::AppHandle, state: tauri::State<'_, AppState>, action: String, value: Option<String>) -> Result<serde_json::Value, PylonError> {
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
    persist_pet_if_possible(&app, &pet);
    Ok(result)
}
