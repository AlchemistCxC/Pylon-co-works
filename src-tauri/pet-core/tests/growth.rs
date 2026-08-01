use pylon_pet_core::{AiEvent, GrowthStage, PetState, ToolOutcome};

/// 测试辅助（M8）：构造"本地 Day 时段（12:00）"的宠物——任意 now_ms 映射到
/// 本地正午，隔离午夜 bond ×1.5 加成（时段相关断言用显式 offset 的变体测试）。
fn day_pet(now_ms: u64) -> PetState {
    let mut pet = PetState::new_at(now_ms);
    let utc_hour = (now_ms / 3_600_000 % 24) as i32;
    pet.set_local_offset_minutes((12 - utc_hour) * 60);
    pet
}

#[test]
fn token_usage_awards_xp_only_for_new_cumulative_tokens() {
    let mut pet = PetState::new_at(0);
    pet.apply(AiEvent::TokenUsage { total: 8_000 }, 1);
    pet.apply(AiEvent::TokenUsage { total: 8_000 }, 2);
    pet.apply(AiEvent::TokenUsage { total: 13_000 }, 3);

    assert_eq!(pet.stats.tokens_total, 13_000);
    assert_eq!(pet.stats.token_xp, 2);
    assert_eq!(pet.xp, 2);
}

#[test]
fn tool_outcomes_build_reliable_statistics_and_growth() {
    let mut pet = PetState::new_at(0);
    for now in 1..=12 {
        let outcome = if now <= 9 { ToolOutcome::Succeeded } else { ToolOutcome::Failed };
        pet.apply(AiEvent::ToolCall { outcome }, now);
    }

    assert_eq!(pet.stats.tools_started, 12);
    assert_eq!(pet.stats.tools_succeeded, 9);
    assert_eq!(pet.stats.tools_failed, 3);
    assert_eq!(pet.stats.tool_success_rate, 75);
    assert!(pet.xp > 0);
}

#[test]
fn growth_stage_comes_from_xp_not_manual_feeding_spam() {
    let mut pet = PetState::new_at(0);
    for now in 1..=100 {
        pet.apply(AiEvent::Poke, now);
        pet.apply(AiEvent::Feed, now);
    }
    assert_eq!(pet.stage(), GrowthStage::Seed);

    for now in 101..=150 {
        pet.apply(AiEvent::PromptCompleted, now);
    }
    assert!(pet.stage() >= GrowthStage::Sprout);
}

#[test]
fn restores_old_data_by_clamping_and_recomputing_derived_stats() {
    let mut saved = PetState::new_at(0);
    saved.name = " 12345678901234567890 ".into();
    saved.happiness = 250;
    saved.energy = 250;
    saved.stats.tools_started = 4;
    saved.stats.tools_succeeded = 3;
    saved.stats.tool_success_rate = 0;

    let restored = PetState::restore(saved, 86_400_000);

    assert_eq!(restored.name.chars().count(), 12);
    assert_eq!(restored.happiness, 98);
    assert_eq!(restored.energy, 100);
    assert_eq!(restored.stats.tool_success_rate, 75);
    assert_eq!(restored.age_days(86_400_000), 2);
}

#[test]
fn sleepy_pet_is_woken_by_interaction_not_polling() {
    // 审查修复：轮询 Visit 不唤醒（睡眠可持续）；真实互动唤醒
    let mut pet = PetState::new_at(0);
    pet.apply(AiEvent::FirstChunk, 1);
    assert!(pet.check_sleepy(31_000), "30s idle after first chunk must fall asleep");
    assert_eq!(pet.mood, "sleepy");
    assert_eq!(pet.machine, pylon_pet_core::PetMachineState::Asleep);

    // 轮询心跳不唤醒
    pet.apply(AiEvent::Visit, 31_001);
    assert_eq!(pet.machine, pylon_pet_core::PetMachineState::Asleep, "轮询 Visit 不得唤醒睡眠宠物");
    // 真实互动唤醒
    pet.apply(AiEvent::Poke, 31_002);
    assert_eq!(pet.machine, pylon_pet_core::PetMachineState::Awake(pylon_pet_core::MachineSub::Idle), "互动必须唤醒");
    assert_eq!(pet.mood, "happy", "Poke 后窗口推导 happy");
}

#[test]
fn first_completion_and_evolution_become_memories() {
    let mut pet = PetState::new_at(0);
    for now in 1..=9 {
        pet.apply(AiEvent::PromptCompleted, now);
    }
    assert_eq!(pet.stage(), GrowthStage::Sprout);
    assert!(pet.memories.iter().any(|m| m.contains("第一次任务")));
    assert!(pet.memories.iter().any(|m| m.contains("蜕变为初生体")));
}

#[test]
fn agent_connect_and_crash_move_mood_and_stats() {
    let mut pet = PetState::new_at(0);
    let happiness_before = pet.happiness;

    pet.apply(AiEvent::AgentConnected, 1);
    assert_eq!(pet.mood, "excited");
    assert_eq!(pet.bond, 1);

    pet.apply(AiEvent::AgentCrashed, 2);
    assert_eq!(pet.mood, "error");
    // v2：连接时 happy +1，崩溃 -2
    assert_eq!(pet.happiness, happiness_before.saturating_sub(1));
}

#[test]
fn token_delta_awards_step_xp_like_full_usage() {
    let mut pet = PetState::new_at(0);
    pet.apply(AiEvent::TokenDelta { amount: 8_000 }, 1);
    pet.apply(AiEvent::TokenDelta { amount: 5_000 }, 2);
    assert_eq!(pet.stats.tokens_total, 13_000);
    assert_eq!(pet.xp, 2);
}

// ── M1：需求衰减引擎 / 数值系统基础 / 迁移 ──

#[test]
fn needs_decay_over_time_and_clamp_at_zero() {
    let mut pet = PetState::new_at(1); // last_tick=1ms，首次 apply 即开始结算
    pet.apply(AiEvent::Visit, 60_000); // dt≈1 分钟，几乎无衰减
    assert_eq!(pet.hunger, 80);
    assert_eq!(pet.energy, 80); // 同一天 visit 无 +20

    pet.apply(AiEvent::Visit, 3 * 3_600_000); // 距上次 3h
    assert!(pet.hunger < 80, "hunger 必须随时间衰减");
    assert!(pet.loneliness > 0, "loneliness 必须随时间上涨");
}

#[test]
fn offline_decay_is_capped_at_24h() {
    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::Visit, 48 * 3_600_000); // 离线 48h：只按 24h 结算
    assert_eq!(pet.hunger, 0, "24h 后 hunger 归零");
    assert!(pet.bond <= 12, "饥饿惩罚封顶（24h×0.5=12）");
    assert_eq!(pet.loneliness, 100, "loneliness 封顶 100");
}

#[test]
fn feeding_restores_hunger_and_play_restores_fun() {
    let mut pet = PetState::new_at(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.apply(AiEvent::Feed, 1);
    assert_eq!(pet.hunger, 100);
    pet.apply(AiEvent::Feed, 2); // 30s 冷却内：bond 不加但 hunger 仍恢复
    assert_eq!(pet.hunger, 100);

    // 好奇=0 时 play 收益为设计基准 +25
    let mut pet = PetState::new_at(1);
    pet.traits = pylon_pet_core::PetTraits { curiosity: 0, ..pylon_pet_core::PetTraits::default() };
    pet.apply(AiEvent::Play, 1);
    assert_eq!(pet.fun, 95, "play 恢复 fun +25（curiosity=0 基准）");
    assert_eq!(pet.loneliness, 0, "play 大幅降低孤独");
    assert_eq!(pet.energy, 70, "play 消耗 energy -10");
    // 好奇加成：curiosity=100 → fun +50
    let mut pet = PetState::new_at(1);
    pet.traits = pylon_pet_core::PetTraits { curiosity: 100, ..pylon_pet_core::PetTraits::default() };
    pet.apply(AiEvent::Play, 1);
    assert_eq!(pet.fun, 100, "curiosity=100 时 fun 收益翻倍");
}

#[test]
fn greedy_pet_hungers_faster() {
    let mut pet = PetState::new_at(1);
    pet.traits.greed = 100;
    pet.apply(AiEvent::Visit, 3_600_000); // 1h
    let greedy_hunger = pet.hunger;
    let mut normal = PetState::new_at(1);
    normal.apply(AiEvent::Visit, 3_600_000);
    assert!(greedy_hunger < normal.hunger, "贪吃 trait 必须加速饥饿");
}

#[test]
fn v1_snapshot_roundtrips_with_new_fields_defaulted() {
    // 模拟 v1 存档（无 v2 字段）：serde default 补齐后 restore 无损
    let legacy = serde_json::json!({
        "name": "微栖",
        "mood": "idle",
        "happiness": 65,
        "energy": 80,
        "xp": 0,
        "bond": 0,
        "born_at_ms": 0,
        "last_seen_day": 0,
        "first_chunk_at_ms": null,
        "stats": {},
        "memories": []
    });
    let saved: PetState = serde_json::from_value(legacy).expect("v1 存档必须可反序列化");
    let restored = PetState::restore(saved, 86_400_000);
    assert_eq!(restored.hunger, 80, "v2 缺省 hunger=80");
    assert_eq!(restored.fun, 70);
    assert_eq!(restored.traits, pylon_pet_core::PetTraits::default());
    assert_eq!(restored.machine, pylon_pet_core::PetMachineState::default());
    assert_eq!(restored.name, "微栖");
}

#[test]
fn recent_events_window_is_ring_buffered() {
    let mut pet = PetState::new_at(0);
    for _ in 0..20 {
        pet.apply(AiEvent::PromptCompleted, 1);
    }
    assert!(pet.recent_events.len() <= 8, "感知窗口环形 8");
}

// ── M2：HSM 状态机（设计书 §5）──

#[test]
fn conversation_drives_interacting_idle_transitions() {
    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::FirstChunk, 1);
    assert_eq!(pet.machine, pylon_pet_core::PetMachineState::Awake(pylon_pet_core::MachineSub::Interacting));
    pet.apply(AiEvent::PromptCompleted, 2);
    assert_eq!(pet.machine, pylon_pet_core::PetMachineState::Awake(pylon_pet_core::MachineSub::Idle));
}

#[test]
fn crash_and_reconnect_drive_distress_transitions() {
    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::AgentCrashed, 1);
    assert_eq!(pet.machine, pylon_pet_core::PetMachineState::Awake(pylon_pet_core::MachineSub::Distress));
    pet.apply(AiEvent::AgentConnected, 2);
    assert_eq!(pet.machine, pylon_pet_core::PetMachineState::Awake(pylon_pet_core::MachineSub::Idle));
}

#[test]
fn exhausted_pet_falls_asleep_and_recovers_energy() {
    let mut pet = PetState::new_at(1);
    pet.energy = 14; // ≤15
    pet.apply(AiEvent::Visit, 31_000); // 30s 无互动
    assert_eq!(pet.machine, pylon_pet_core::PetMachineState::Asleep);
    assert_eq!(pet.mood, "sleepy");
    // 睡眠中 30 分钟：energy +60 恢复；轮询 Visit 不唤醒（审查修复）
    pet.apply(AiEvent::Visit, 31_000 + 1_800_000);
    assert_eq!(pet.machine, pylon_pet_core::PetMachineState::Asleep, "轮询不得唤醒");
    assert_eq!(pet.energy, 74, "睡眠恢复 energy（14+60=74）");
    // 真实互动唤醒（wake 再 +30）
    pet.apply(AiEvent::Poke, 31_000 + 1_800_001);
    assert_eq!(pet.machine, pylon_pet_core::PetMachineState::Awake(pylon_pet_core::MachineSub::Idle), "互动必须唤醒");
    assert_eq!(pet.energy, 100, "睡眠恢复 60 + 唤醒加成 30 = 100（封顶）");
}

#[test]
fn force_sleep_when_energy_hits_zero() {
    let mut pet = PetState::new_at(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.apply(AiEvent::Visit, 3 * 3_600_000); // 3h 后 energy 掉到 0
    assert_eq!(pet.machine, pylon_pet_core::PetMachineState::Asleep, "energy=0 必须强制入睡");
}

// ── M3：情绪推导（设计书 §6）──

#[test]
fn mood_derives_from_needs() {
    let mut pet = PetState::new_at(1);
    pet.hunger = 10;
    pet.apply(AiEvent::Visit, 1);
    assert_eq!(pet.mood, "hungry", "hunger<20 → hungry");

    let mut pet = PetState::new_at(1);
    pet.loneliness = 80;
    pet.apply(AiEvent::Visit, 1);
    assert_eq!(pet.mood, "lonely", "loneliness>60 → lonely");

    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::Poke, 1); // 更新最近互动时间（防入睡）
    pet.energy = 10;
    pet.apply(AiEvent::Visit, 1);
    assert_eq!(pet.mood, "tired", "energy<20 → tired（需求优先于窗口 happy）");
}

#[test]
fn mood_derives_from_recent_events() {
    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::Poke, 1);
    assert_eq!(pet.mood, "happy", "Poke 后窗口 → happy");

    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::ToolCall { outcome: ToolOutcome::Succeeded }, 1);
    assert_eq!(pet.mood, "focused", "工具成功 → focused");

    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::ToolCall { outcome: ToolOutcome::Failed }, 1);
    assert_eq!(pet.mood, "error", "工具失败（近 3）→ error");

    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::AgentCrashed, 1);
    assert_eq!(pet.mood, "error", "崩溃 → error");
}

#[test]
fn feeding_recovers_mood_from_hungry_to_happy() {
    let mut pet = PetState::new_at(1);
    pet.hunger = 10;
    pet.apply(AiEvent::Feed, 1);
    assert_eq!(pet.mood, "happy", "喂食后 hunger>20 且窗口含 Feed → happy（不再 hungry）");
}

#[test]
fn failure_event_overrides_recent_happy_mood() {
    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::Poke, 1);
    assert_eq!(pet.mood, "happy");
    // 失败（近 3）优先级高于窗口 happy
    pet.apply(AiEvent::ToolCall { outcome: ToolOutcome::Failed }, 2);
    assert_eq!(pet.mood, "error", "失败事件必须压过 happy");
    // 需求危机优先于 happy（无失败事件时）
    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::Poke, 1);
    pet.hunger = 10;
    pet.apply(AiEvent::Poke, 2);
    assert_eq!(pet.mood, "hungry", "饥饿优先于 happy");
}

// ── M4：个性 traits + 防刷平衡（设计书 §7/§13.5.4）──

#[test]
fn feeding_spam_diminishes_returns() {
    let mut pet = PetState::new_at(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.apply(AiEvent::Feed, 1);
    assert_eq!(pet.hunger, 100, "首次喂食全收益");
    // 30s 内连喂：50% 收益（hunger 已满，看 energy）
    let e1 = pet.energy;
    pet.apply(AiEvent::Feed, 2);
    assert_eq!(pet.energy, (e1 as u16 + 10).min(100) as u8, "第二次喂食 50%");
    // 30s 后重置
    let mut pet = PetState::new_at(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.hunger = 50;
    pet.apply(AiEvent::Feed, 1);
    pet.hunger = 50;
    pet.apply(AiEvent::Feed, 30_001); // 超过冷却
    assert_eq!(pet.hunger, 70, "冷却后恢复全收益（+20）");
}

#[test]
fn play_has_sixty_second_bond_cooldown() {
    // M8：显式映射到本地 Day 时段（12:00），隔离午夜 bond ×1.5 加成
    let mut pet = day_pet(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.apply(AiEvent::Play, 1);
    assert_eq!(pet.bond, 3, "首次玩耍 +3 bond");
    pet.apply(AiEvent::Play, 2);
    assert_eq!(pet.bond, 3, "60s 内重复玩耍不加 bond");
    pet.apply(AiEvent::Play, 60_002);
    assert_eq!(pet.bond, 6, "冷却后再次 +3");
}

#[test]
fn greedy_pet_gets_more_bond_from_food() {
    // 审查修复：贪吃影响喂食 bond 收益（设计书 §7），不再影响 hunger 恢复
    // M8：显式映射到本地 Day 时段（12:00），隔离午夜 bond ×1.5 加成
    let mut pet = day_pet(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.traits.greed = 100;
    pet.hunger = 50;
    pet.apply(AiEvent::Feed, 1);
    assert_eq!(pet.hunger, 70, "hunger 收益固定 +20");
    assert_eq!(pet.bond, 2, "贪吃喂食 bond +2（×2）");
    let mut normal = day_pet(1);
    normal.traits = pylon_pet_core::PetTraits::default();
    normal.hunger = 50;
    normal.apply(AiEvent::Feed, 1);
    assert_eq!(normal.hunger, 70);
    assert_eq!(normal.bond, 1, "普通喂食 bond +1");
}

#[test]
fn clingy_pet_loses_bond_when_neglected() {
    let mut pet = PetState::new_at(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.bond = 100;
    pet.loneliness = 80; // ≥80 触发冷落惩罚
    pet.apply(AiEvent::Visit, 3_600_000); // 1h 冷落
    assert!(pet.bond < 100, "孤独≥80 持续必须掉 bond");
    // 不黏人的宠物不受此惩罚（孤独<80）
    let mut pet = PetState::new_at(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.bond = 100;
    pet.loneliness = 50;
    pet.apply(AiEvent::Visit, 3_600_000);
    assert_eq!(pet.bond, 100);
}

#[test]
fn random_traits_are_in_bounds_and_differ() {
    let a = pylon_pet_core::PetTraits::random();
    let b = pylon_pet_core::PetTraits::random();
    for trait_value in [a.activity, a.clinginess, a.greed, a.curiosity] {
        assert!((10..=100).contains(&trait_value), "trait 必须 10-100");
    }
    assert!(a != b || a != pylon_pet_core::PetTraits::random(), "随机应有个体差异");
}

// ── M5：Agent 感知层（设计书 §8）──

#[test]
fn tool_kind_classification_dictionary() {
    use pylon_pet_core::ToolKind;
    assert_eq!(ToolKind::classify("edit_file"), ToolKind::Code);
    assert_eq!(ToolKind::classify("write_file"), ToolKind::Code);
    assert_eq!(ToolKind::classify("apply_patch"), ToolKind::Code);
    assert_eq!(ToolKind::classify("spawn_agent"), ToolKind::AgentSpawn);
    assert_eq!(ToolKind::classify("delegate"), ToolKind::AgentSpawn);
    assert_eq!(ToolKind::classify("bash"), ToolKind::Execute);
    assert_eq!(ToolKind::classify("run_command"), ToolKind::Execute);
    assert_eq!(ToolKind::classify("web_search"), ToolKind::Network);
    assert_eq!(ToolKind::classify("read_file"), ToolKind::Read);
    assert_eq!(ToolKind::classify("grep"), ToolKind::Read);
    assert_eq!(ToolKind::classify("custom_tool"), ToolKind::Other);
    // 顺序：AgentSpawn 必须在 Execute 前检查（run_agent 含 "run"）
    assert_eq!(ToolKind::classify("run_agent"), ToolKind::AgentSpawn);
}

#[test]
fn code_tool_start_feeds_pet_stats() {
    use pylon_pet_core::ToolKind;
    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::ToolStarted { kind: ToolKind::Code }, 1);
    assert_eq!(pet.stats.code_sessions, 1);
    assert_eq!(pet.mood, "curious", "Code 窗口 → curious（凑近看代码）");
    pet.apply(AiEvent::ToolStarted { kind: ToolKind::Code }, 2);
    assert_eq!(pet.stats.code_sessions, 2);
}

#[test]
fn code_file_recording_is_sanitized_and_capped() {
    let mut pet = PetState::new_at(1);
    pet.record_code_file("G:/Project/src/lib.rs");
    pet.record_code_file("src/main.ts");
    pet.record_code_file("src/main.ts"); // 去重
    assert_eq!(pet.stats.code_files, vec!["lib.rs".to_string(), "main.ts".to_string()], "仅文件名且去重");
    for i in 0..12 {
        pet.record_code_file(&format!("file-{i}.rs"));
    }
    assert!(pet.stats.code_files.len() <= 10, "上限 10 滚动");
}

#[test]
fn timeout_dazes_pet_and_recovers_fun() {
    let mut pet = PetState::new_at(1);
    pet.fun = 30;
    pet.apply(AiEvent::PromptTimeout, 1);
    assert_eq!(pet.stats.dazes, 1);
    assert_eq!(pet.fun, 35, "发呆恢复 fun +5");
    assert_eq!(pet.mood, "dazed", "超时 → dazed");
}

#[test]
fn cancelled_tool_startles_pet() {
    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::ToolCancelled, 1);
    assert_eq!(pet.mood, "startled");
    // ToolCall{outcome: Cancelled} 等价
    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::ToolCall { outcome: pylon_pet_core::ToolOutcome::Cancelled }, 1);
    assert_eq!(pet.mood, "startled");
}

#[test]
fn mode_and_model_changes_are_sensed() {
    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::ModeChanged { mode: "code".into() }, 1);
    assert_eq!(pet.mood, "focused", "code 模式 → focused");
    pet.apply(AiEvent::ModelChanged { model: "deepseek-v4".into() }, 2);
    assert!(pet.memories.iter().any(|m| m.contains("换了个脑子")), "模型切换必须记入记忆");
    let count = pet.memories.len();
    pet.apply(AiEvent::ModelChanged { model: "deepseek-v4".into() }, 3);
    assert_eq!(pet.memories.len(), count, "同模型不重复记忆");
}

#[test]
fn refusal_and_maxed_are_distinct() {
    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::PromptRefused, 1);
    assert_eq!(pet.mood, "confused");
    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::PromptMaxed, 1);
    assert_eq!(pet.mood, "tired");
}

#[test]
fn code_seen_counts_watching() {
    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::CodeSeen, 1);
    pet.apply(AiEvent::CodeSeen, 2);
    assert_eq!(pet.stats.code_watched, 2);
}

// ── M6：crafting 延迟行为 + 主动说话（设计书 §9）──

#[test]
fn friend_crafting_completes_after_thirty_seconds() {
    use pylon_pet_core::ToolKind;
    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::ToolStarted { kind: ToolKind::AgentSpawn }, 1);
    assert!(pet.pending_action.is_some(), "捏朋友必须挂起延迟行为");
    assert!(!pet.settle_pending(29_999), "30s 前未完成");
    assert!(pet.settle_pending(30_001), "30s 后完成");
    assert!(pet.pending_action.is_none());
    assert_eq!(pet.stats.friends_made, 1);
    assert!(pet.memories.iter().any(|m| m.contains("幻影朋友")), "捏朋友必须记入记忆");
    assert!(pet.bond >= 2);
    assert!(pet.msg.is_some(), "完成必须说话");
}

#[test]
fn poll_voice_reports_need_priorities() {
    let mut pet = PetState::new_at(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    assert!(!pet.poll_voice(1), "健康时不说话");
    pet.hunger = 10;
    assert!(pet.poll_voice(2), "饥饿必须说话");
    assert!(pet.msg.as_deref() == Some("咕……") || pet.msg.is_some());
    pet.msg = None;

    pet.hunger = 80;
    pet.loneliness = 90;
    assert!(pet.poll_voice(3), "孤独必须说话");
    pet.msg = None;

    // 已 asleep 不说话
    pet.apply(AiEvent::Sleepy, 4);
    assert!(!pet.poll_voice(5), "睡眠中不说话");
}

#[test]
fn voice_lines_rotate_without_immediate_repeat() {
    let mut pet = PetState::new_at(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.hunger = 10;
    let first = {
        pet.poll_voice(1);
        pet.msg.take()
    };
    let second = {
        pet.poll_voice(2);
        pet.msg.take()
    };
    assert!(first.is_some() && second.is_some());
    assert_ne!(first, second, "文案池必须轮换不重复");
}

// ── M8：时段感知（day_part / 午夜陪伴 / 深夜不打扰 / 时段文案）──

#[test]
fn day_part_boundaries_are_stable() {
    use pylon_pet_core::day_part_of_hour;
    use pylon_pet_core::DayPart;
    assert_eq!(day_part_of_hour(0), DayPart::Night);
    assert_eq!(day_part_of_hour(4), DayPart::Night);
    assert_eq!(day_part_of_hour(5), DayPart::Dawn);
    assert_eq!(day_part_of_hour(7), DayPart::Dawn);
    assert_eq!(day_part_of_hour(8), DayPart::Day);
    assert_eq!(day_part_of_hour(17), DayPart::Day);
    assert_eq!(day_part_of_hour(18), DayPart::Dusk);
    assert_eq!(day_part_of_hour(21), DayPart::Dusk);
    assert_eq!(day_part_of_hour(22), DayPart::Night);
    assert_eq!(day_part_of_hour(23), DayPart::Night);
}

#[test]
fn day_part_respects_local_offset_and_clamps() {
    use pylon_pet_core::DayPart;
    // UTC 0 点（1970-01-01 00:00）+ 8h = 本地 8:00 → Day
    let mut pet = PetState::new_at(0);
    pet.set_local_offset_minutes(8 * 60);
    assert_eq!(pet.day_part(0), DayPart::Day);
    // +14h = 本地 14:00 → Day；+15h = 15:00 → Day
    pet.set_local_offset_minutes(15 * 60);
    assert_eq!(pet.day_part(0), DayPart::Day);
    // 负偏移：UTC 0 点 - 5h = 前日 19:00 → Dusk
    pet.set_local_offset_minutes(-5 * 60);
    assert_eq!(pet.day_part(0), DayPart::Dusk);
    // 越界钳制（±24h 上限）：99h → 钳到 24h，hour=24 mod 24 = 0 → Night
    //（24h 偏移 ≡ 0h 偏移，同一时刻）
    pet.set_local_offset_minutes(99 * 60);
    assert_eq!(pet.day_part(0), DayPart::Night);
    // 0 = UTC（默认）
    let pet = PetState::new_at(0);
    assert_eq!(pet.day_part(0), DayPart::Night);
}

#[test]
fn night_interactions_grant_bonus_bond() {
    // 午夜陪伴（设计书 §13.5.5）：Night 时段互动 bond ×1.5（向上取整）
    // now=0 → UTC hour 0 → Night（offset 0）
    let mut pet = PetState::new_at(0);
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.apply(AiEvent::UserSent, 0);
    assert_eq!(pet.bond, 2, "Night 发消息 bond 1×1.5 向上取整 = 2");
    // 对照 Day 时段：bond 1
    let mut day = day_pet(1);
    day.traits = pylon_pet_core::PetTraits::default();
    day.apply(AiEvent::UserSent, 1);
    assert_eq!(day.bond, 1, "Day 发消息 bond +1");
    // Night 玩耍：3×1.5 = 5（向上取整）
    let mut pet = PetState::new_at(0);
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.apply(AiEvent::Play, 0);
    assert_eq!(pet.bond, 5, "Night 玩耍 bond 3×1.5 = 5");
    // Night 喂食（普通 traits）：1×1.5 = 2
    let mut pet = PetState::new_at(0);
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.apply(AiEvent::Feed, 0);
    assert_eq!(pet.bond, 2, "Night 喂食 bond 1×1.5 = 2");
}

#[test]
fn night_poll_voice_skips_bored() {
    // 深夜不打扰：Night 时段 fun<20 不说 BORED（紧急需求仍说）
    let mut pet = PetState::new_at(0); // UTC 0 点 = Night
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.fun = 5;
    assert!(!pet.poll_voice(0), "Night 不说 BORED");
    // 紧急需求仍说（饥饿优先于深夜规则）
    pet.hunger = 10;
    assert!(pet.poll_voice(0), "Night 饥饿仍必须说话");
    // Day 时段照常说 BORED
    let mut day = day_pet(1);
    day.traits = pylon_pet_core::PetTraits::default();
    day.fun = 5;
    assert!(day.poll_voice(1), "Day fun<20 说 BORED");
}

#[test]
fn time_of_day_line_variants_are_used() {
    use pylon_pet_core::DayPart;
    use pylon_pet_core::lines::{pick, LineKey};
    let mut idx = 0u8;
    let wake_night = pick(LineKey::Wake, &mut idx, DayPart::Night);
    assert!(wake_night.contains("夜深") || wake_night.contains("黑暗"), "Night Wake 变体: {wake_night}");
    let wake_day = pick(LineKey::Wake, &mut idx, DayPart::Day);
    assert!(wake_day.contains("脚步") || wake_day.contains("懒腰"), "Day Wake 普通池: {wake_day}");
    let sleep_day = pick(LineKey::Sleep, &mut idx, DayPart::Day);
    assert!(sleep_day.contains("时区") || sleep_day.contains("阳光"), "Day Sleep 变体: {sleep_day}");
    let sleep_default = pick(LineKey::Sleep, &mut idx, DayPart::Night);
    assert!(sleep_default.contains("蜷成") || sleep_default.contains("注释"), "Night Sleep 普通池: {sleep_default}");
    let done_night = pick(LineKey::Done, &mut idx, DayPart::Night);
    assert!(done_night.contains("深夜") || done_night.contains("夜深"), "Night Done 变体: {done_night}");
    // 无时段变体的场景（Poke）不随时段变化
    let poke_a = pick(LineKey::Poke, &mut idx, DayPart::Night);
    let poke_b = pick(LineKey::Poke, &mut idx, DayPart::Day);
    assert!(poke_a.contains("指尖") || poke_a.contains("晃了晃"));
    assert!(poke_b.contains("指尖") || poke_b.contains("晃了晃"));
}
