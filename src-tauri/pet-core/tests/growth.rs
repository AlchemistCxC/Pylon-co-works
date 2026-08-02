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
        let outcome = if now <= 9 {
            ToolOutcome::Succeeded
        } else {
            ToolOutcome::Failed
        };
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
fn restore_clamps_injected_values_and_drops_unknown_ids() {
    // A13：手改/损坏存档注入天文数字与未知 id → 钳制到上限 + 白名单剔除
    let mut saved = PetState::new_at(0);
    saved.xp = u32::MAX;
    saved.bond = u32::MAX;
    saved.stats.messages = u64::MAX;
    saved.stats.tokens_total = u64::MAX;
    saved.stats.token_xp = u32::MAX;
    saved.unlocked = vec!["fake_achievement".into(), "first_step".into()];
    saved.inventory = vec!["fake_item".into(), "beret".into()];
    saved.equipped = Some("fake_item".into());

    let restored = PetState::restore(saved, 86_400_000);

    assert_eq!(restored.xp, 999_999, "注入 xp 必须钳制到 999_999");
    assert_eq!(restored.bond, 9_999, "注入 bond 必须钳制到 9_999");
    assert_eq!(restored.stats.messages, 10_000_000, "注入统计必须钳制");
    assert_eq!(restored.stats.tokens_total, 10_000_000);
    assert_eq!(restored.stats.token_xp, 10_000_000);
    assert!(
        !restored.unlocked.iter().any(|id| id.starts_with("fake")),
        "未知成就 id 必须剔除（不因注入解锁）: {:?}",
        restored.unlocked
    );
    assert!(
        restored.unlocked.contains(&"first_step".to_string()),
        "合法成就 id 必须保留"
    );
    assert_eq!(
        restored.inventory,
        vec!["beret".to_string()],
        "未知装扮 id 必须剔除"
    );
    assert!(restored.equipped.is_none(), "未知装备 id → None");
    assert_eq!(
        restored.stats.cosmetics_collected, 1,
        "cosmetics_collected 按 retain 后重算"
    );
}

#[test]
fn sleepy_pet_is_woken_by_interaction_not_polling() {
    // 审查修复：轮询 Visit 不唤醒（睡眠可持续）；真实互动唤醒
    let mut pet = PetState::new_at(0);
    pet.apply(AiEvent::FirstChunk, 1);
    assert!(
        pet.check_sleepy(31_000),
        "30s idle after first chunk must fall asleep"
    );
    assert_eq!(pet.mood, "sleepy");
    assert_eq!(pet.machine, pylon_pet_core::PetMachineState::Asleep);

    // 轮询心跳不唤醒
    pet.apply(AiEvent::Visit, 31_001);
    assert_eq!(
        pet.machine,
        pylon_pet_core::PetMachineState::Asleep,
        "轮询 Visit 不得唤醒睡眠宠物"
    );
    // 真实互动唤醒
    pet.apply(AiEvent::Poke, 31_002);
    assert_eq!(
        pet.machine,
        pylon_pet_core::PetMachineState::Awake(pylon_pet_core::MachineSub::Idle),
        "互动必须唤醒"
    );
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
    pet.traits = pylon_pet_core::PetTraits {
        curiosity: 0,
        ..pylon_pet_core::PetTraits::default()
    };
    pet.apply(AiEvent::Play, 1);
    assert_eq!(pet.fun, 95, "play 恢复 fun +25（curiosity=0 基准）");
    assert_eq!(pet.loneliness, 0, "play 大幅降低孤独");
    assert_eq!(pet.energy, 70, "play 消耗 energy -10");
    // 好奇加成：curiosity=100 → fun +50
    let mut pet = PetState::new_at(1);
    pet.traits = pylon_pet_core::PetTraits {
        curiosity: 100,
        ..pylon_pet_core::PetTraits::default()
    };
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
    assert_eq!(
        pet.machine,
        pylon_pet_core::PetMachineState::Awake(pylon_pet_core::MachineSub::Interacting)
    );
    pet.apply(AiEvent::PromptCompleted, 2);
    assert_eq!(
        pet.machine,
        pylon_pet_core::PetMachineState::Awake(pylon_pet_core::MachineSub::Idle)
    );
}

#[test]
fn crash_and_reconnect_drive_distress_transitions() {
    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::AgentCrashed, 1);
    assert_eq!(
        pet.machine,
        pylon_pet_core::PetMachineState::Awake(pylon_pet_core::MachineSub::Distress)
    );
    pet.apply(AiEvent::AgentConnected, 2);
    assert_eq!(
        pet.machine,
        pylon_pet_core::PetMachineState::Awake(pylon_pet_core::MachineSub::Idle)
    );
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
    assert_eq!(
        pet.machine,
        pylon_pet_core::PetMachineState::Asleep,
        "轮询不得唤醒"
    );
    assert_eq!(pet.energy, 74, "睡眠恢复 energy（14+60=74）");
    // 真实互动唤醒（wake 再 +30）
    pet.apply(AiEvent::Poke, 31_000 + 1_800_001);
    assert_eq!(
        pet.machine,
        pylon_pet_core::PetMachineState::Awake(pylon_pet_core::MachineSub::Idle),
        "互动必须唤醒"
    );
    assert_eq!(pet.energy, 100, "睡眠恢复 60 + 唤醒加成 30 = 100（封顶）");
}

#[test]
fn force_sleep_when_energy_hits_zero() {
    let mut pet = PetState::new_at(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.apply(AiEvent::Visit, 3 * 3_600_000); // 3h 后 energy 掉到 0
    assert_eq!(
        pet.machine,
        pylon_pet_core::PetMachineState::Asleep,
        "energy=0 必须强制入睡"
    );
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
    assert_eq!(
        pet.mood, "tired",
        "energy<20 → tired（需求优先于窗口 happy）"
    );
}

#[test]
fn mood_derives_from_recent_events() {
    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::Poke, 1);
    assert_eq!(pet.mood, "happy", "Poke 后窗口 → happy");

    let mut pet = PetState::new_at(1);
    pet.apply(
        AiEvent::ToolCall {
            outcome: ToolOutcome::Succeeded,
        },
        1,
    );
    assert_eq!(pet.mood, "focused", "工具成功 → focused");

    let mut pet = PetState::new_at(1);
    pet.apply(
        AiEvent::ToolCall {
            outcome: ToolOutcome::Failed,
        },
        1,
    );
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
    assert_eq!(
        pet.mood, "happy",
        "喂食后 hunger>20 且窗口含 Feed → happy（不再 hungry）"
    );
}

#[test]
fn failure_event_overrides_recent_happy_mood() {
    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::Poke, 1);
    assert_eq!(pet.mood, "happy");
    // 失败（近 3）优先级高于窗口 happy
    pet.apply(
        AiEvent::ToolCall {
            outcome: ToolOutcome::Failed,
        },
        2,
    );
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
    assert_eq!(
        pet.energy,
        (e1 as u16 + 10).min(100) as u8,
        "第二次喂食 50%"
    );
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
    assert!(
        a != b || a != pylon_pet_core::PetTraits::random(),
        "随机应有个体差异"
    );
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
    pet.apply(
        AiEvent::ToolStarted {
            kind: ToolKind::Code,
        },
        1,
    );
    assert_eq!(pet.stats.code_sessions, 1);
    assert_eq!(pet.mood, "curious", "Code 窗口 → curious（凑近看代码）");
    pet.apply(
        AiEvent::ToolStarted {
            kind: ToolKind::Code,
        },
        2,
    );
    assert_eq!(pet.stats.code_sessions, 2);
}

#[test]
fn code_file_recording_is_sanitized_and_capped() {
    let mut pet = PetState::new_at(1);
    pet.record_code_file("G:/Project/src/lib.rs");
    pet.record_code_file("src/main.ts");
    pet.record_code_file("src/main.ts"); // 去重
    assert_eq!(
        pet.stats.code_files,
        vec!["lib.rs".to_string(), "main.ts".to_string()],
        "仅文件名且去重"
    );
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
    pet.apply(
        AiEvent::ToolCall {
            outcome: pylon_pet_core::ToolOutcome::Cancelled,
        },
        1,
    );
    assert_eq!(pet.mood, "startled");
}

#[test]
fn mode_and_model_changes_are_sensed() {
    let mut pet = PetState::new_at(1);
    pet.apply(
        AiEvent::ModeChanged {
            mode: "code".into(),
        },
        1,
    );
    assert_eq!(pet.mood, "focused", "code 模式 → focused");
    pet.apply(
        AiEvent::ModelChanged {
            model: "deepseek-v4".into(),
        },
        2,
    );
    assert!(
        pet.memories.iter().any(|m| m.contains("换了个脑子")),
        "模型切换必须记入记忆"
    );
    let count = pet.memories.len();
    pet.apply(
        AiEvent::ModelChanged {
            model: "deepseek-v4".into(),
        },
        3,
    );
    assert_eq!(pet.memories.len(), count, "同模型不重复记忆");
}

#[test]
fn refusal_and_maxed_are_distinct() {
    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::PromptRefused, 1);
    assert_eq!(pet.mood, "confused");
    // C12：拒绝/达上限同样结束对话 → Idle（不卡 Interacting）
    assert_eq!(
        pet.machine,
        pylon_pet_core::PetMachineState::Awake(pylon_pet_core::MachineSub::Idle),
        "PromptRefused 必须回 Idle"
    );
    let mut pet = PetState::new_at(1);
    pet.apply(AiEvent::PromptMaxed, 1);
    assert_eq!(pet.mood, "tired");
    assert_eq!(
        pet.machine,
        pylon_pet_core::PetMachineState::Awake(pylon_pet_core::MachineSub::Idle),
        "PromptMaxed 必须回 Idle"
    );
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
    pet.apply(
        AiEvent::ToolStarted {
            kind: ToolKind::AgentSpawn,
        },
        1,
    );
    assert!(pet.pending_action.is_some(), "捏朋友必须挂起延迟行为");
    assert!(!pet.settle_pending(29_999), "30s 前未完成");
    assert!(pet.settle_pending(30_001), "30s 后完成");
    assert!(pet.pending_action.is_none());
    assert_eq!(pet.stats.friends_made, 1);
    assert!(
        pet.memories.iter().any(|m| m.contains("幻影朋友")),
        "捏朋友必须记入记忆"
    );
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
    // UTC 0 点（1970-01-01 00:00）+ 480 分钟（东八区）= 本地 8:00 → Day
    let mut pet = PetState::new_at(0);
    pet.set_local_offset_minutes(480);
    assert_eq!(pet.day_part(0), DayPart::Day);
    // +900 分钟 = 本地 15:00 → Day
    pet.set_local_offset_minutes(15 * 60);
    assert_eq!(pet.day_part(0), DayPart::Day);
    // 修复（2026-08-02 A2）：480 分钟时 UTC 14:00 = 本地 22:00 → Night
    //（旧实现偏移按小时语义被丢弃，此处恒 Day/恒 UTC——断言修复后为 Night）
    pet.set_local_offset_minutes(480);
    assert_eq!(pet.day_part(14 * 3_600_000), DayPart::Night);
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
fn offset_480_minutes_produces_night_at_local_22h() {
    use pylon_pet_core::DayPart;
    // 东八区（+480 分钟）：UTC 14:00 = 本地 22:00 → Night（修复后深夜功能
    // 生效——Night bond×1.5 / night_visits / 深夜静默按真实本地时段触发）
    let mut pet = PetState::new_at(0);
    pet.set_local_offset_minutes(480);
    assert_eq!(pet.day_part(14 * 3_600_000), DayPart::Night);
    // 跨日回绕：UTC 16:00 = 次日本地 00:00 → 仍 Night
    assert_eq!(pet.day_part(16 * 3_600_000), DayPart::Night);
    // 对照：UTC 4:00 = 本地 12:00 → Day（凌晨本地正午，隔离误判）
    assert_eq!(pet.day_part(4 * 3_600_000), DayPart::Day);
}

#[test]
fn night_interactions_grant_bonus_bond() {
    // 午夜陪伴（设计书 §13.5.5）：Night 时段互动 bond ×1.5（向上取整）
    // now=0 → UTC hour 0 → Night（offset 0）
    // 预置成就解锁（隔离 M9 成就奖励干扰，专注午夜加成本身）
    let isolated = || -> PetState {
        let mut pet = PetState::new_at(0);
        pet.traits = pylon_pet_core::PetTraits::default();
        pet.unlocked = vec!["first_step".into(), "night_watcher".into()];
        pet
    };
    let mut pet = isolated();
    pet.apply(AiEvent::UserSent, 0);
    assert_eq!(pet.bond, 2, "Night 发消息 bond 1×1.5 向上取整 = 2");
    // 对照 Day 时段：bond 1
    let mut day = day_pet(1);
    day.traits = pylon_pet_core::PetTraits::default();
    day.unlocked = vec!["first_step".into()];
    day.apply(AiEvent::UserSent, 1);
    assert_eq!(day.bond, 1, "Day 发消息 bond +1");
    // Night 玩耍：3×1.5 = 5（向上取整）
    let mut pet = isolated();
    pet.apply(AiEvent::Play, 0);
    assert_eq!(pet.bond, 5, "Night 玩耍 bond 3×1.5 = 5");
    // Night 喂食（普通 traits）：1×1.5 = 2
    let mut pet = isolated();
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
    use pylon_pet_core::lines::{pick, LineKey};
    use pylon_pet_core::DayPart;
    let mut idx = 0u8;
    let wake_night = pick(LineKey::Wake, &mut idx, DayPart::Night);
    assert!(
        wake_night.contains("夜深") || wake_night.contains("黑暗"),
        "Night Wake 变体: {wake_night}"
    );
    let wake_day = pick(LineKey::Wake, &mut idx, DayPart::Day);
    assert!(
        wake_day.contains("脚步") || wake_day.contains("懒腰"),
        "Day Wake 普通池: {wake_day}"
    );
    let sleep_day = pick(LineKey::Sleep, &mut idx, DayPart::Day);
    assert!(
        sleep_day.contains("时区") || sleep_day.contains("阳光"),
        "Day Sleep 变体: {sleep_day}"
    );
    let sleep_default = pick(LineKey::Sleep, &mut idx, DayPart::Night);
    assert!(
        sleep_default.contains("蜷成") || sleep_default.contains("注释"),
        "Night Sleep 普通池: {sleep_default}"
    );
    let done_night = pick(LineKey::Done, &mut idx, DayPart::Night);
    assert!(
        done_night.contains("深夜") || done_night.contains("夜深"),
        "Night Done 变体: {done_night}"
    );
    // 无时段变体的场景（Poke）不随时段变化
    let poke_a = pick(LineKey::Poke, &mut idx, DayPart::Night);
    let poke_b = pick(LineKey::Poke, &mut idx, DayPart::Day);
    assert!(poke_a.contains("指尖") || poke_a.contains("晃了晃"));
    assert!(poke_b.contains("指尖") || poke_b.contains("晃了晃"));
}

// ── M9：成就徽章（unlock 幂等 / 奖励 / 记忆 / restore 补查 / 计数）──

#[test]
fn achievements_unlock_with_rewards_and_idempotency() {
    let mut pet = day_pet(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.apply(AiEvent::UserSent, 1);
    // first_step：messages≥1
    assert!(
        pet.unlocked.contains(&"first_step".to_string()),
        "首次对话必须解锁 first_step: {:?}",
        pet.unlocked
    );
    assert!(
        pet.memories.iter().any(|m| m.contains("初次对话")),
        "解锁必须记入记忆"
    );
    // O56：事件文案（UserSent 行）不被徽章文案顶掉
    assert!(
        !pet.msg.as_deref().unwrap_or("").contains("徽章"),
        "事件文案不得被徽章覆盖: {:?}",
        pet.msg
    );
    let xp_after = pet.xp;
    assert!(xp_after >= 2, "first_step 奖励 xp+2: {xp_after}");
    // 幂等：再次触发不重复解锁/重复奖励
    pet.apply(AiEvent::UserSent, 2);
    assert_eq!(
        pet.unlocked
            .iter()
            .filter(|id| id.as_str() == "first_step")
            .count(),
        1,
        "成就只能解锁一次"
    );
    assert_eq!(pet.xp, xp_after, "重复触发不重复奖励");
}

#[test]
fn night_interaction_unlocks_night_watcher_achievement() {
    let mut pet = PetState::new_at(0); // Night（offset 0）
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.apply(AiEvent::Poke, 0);
    assert!(
        pet.unlocked.contains(&"night_watcher".to_string()),
        "Night 互动必须解锁深夜守望"
    );
    assert_eq!(pet.stats.night_visits, 1);
    // 10 次后夜猫子
    for now in 1..=9 {
        pet.apply(AiEvent::Poke, now);
    }
    assert!(
        pet.unlocked.contains(&"night_owl".to_string()),
        "10 次深夜互动必须解锁夜猫子"
    );
    // 计数只记真实互动：Visit（轮询）不计数
    let before = pet.stats.night_visits;
    pet.apply(AiEvent::Visit, 3_600_000);
    assert_eq!(pet.stats.night_visits, before, "Visit 不是真实互动，不计数");
}

#[test]
fn feed_and_play_counts_feed_achievements() {
    let mut pet = day_pet(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    for now in 1..=50 {
        pet.apply(AiEvent::Feed, now);
    }
    assert_eq!(pet.stats.feed_count, 50);
    assert!(
        pet.unlocked.contains(&"gourmet".to_string()),
        "喂食 50 次解锁老饕"
    );
    let mut pet = day_pet(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    for now in 1..=50 {
        pet.apply(AiEvent::Play, now);
    }
    assert_eq!(pet.stats.play_count, 50);
    assert!(!pet.unlocked.contains(&"gourmet".to_string()), "玩耍不喂食");
}

#[test]
fn multiple_achievements_unlock_in_one_event() {
    // O56：本轮回合多枚解锁聚合为一条徽章文案（msg 为空时展示全部）
    let mut pet = day_pet(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.bond = 300;
    pet.stats.feed_count = 50;
    pet.msg = None; // 无事件文案时徽章聚合生效
    pet.apply(AiEvent::Visit, 1);
    assert!(
        pet.unlocked.contains(&"gourmet".to_string()),
        "喂食 50 次必须解锁老饕: {:?}",
        pet.unlocked
    );
    assert!(
        pet.unlocked.contains(&"bond_friend".to_string()),
        "bond 300 必须解锁羁绊伙伴: {:?}",
        pet.unlocked
    );
    let msg = pet.msg.as_deref().unwrap_or("").to_string();
    assert!(msg.contains("徽章"), "多枚解锁必须聚合徽章文案: {msg}");
    assert!(
        msg.contains("老饕") && msg.contains("羁绊伙伴"),
        "聚合文案必须含全部解锁名: {msg}"
    );
    // 事件文案存在时徽章不覆盖（一次 Feed 同时跨两个阈值）
    let mut pet = day_pet(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.bond = 299;
    pet.stats.feed_count = 49;
    pet.apply(AiEvent::Feed, 1);
    assert!(
        pet.unlocked.contains(&"gourmet".to_string()),
        "喂食跨阈值必须解锁老饕: {:?}",
        pet.unlocked
    );
    assert!(
        pet.unlocked.contains(&"bond_friend".to_string()),
        "bond 跨阈值必须解锁羁绊伙伴: {:?}",
        pet.unlocked
    );
    assert!(
        !pet.msg.as_deref().unwrap_or("").contains("徽章"),
        "事件文案（喂食）不得被徽章顶掉: {:?}",
        pet.msg
    );
}

#[test]
fn collector_counts_drops_and_growth_unlocks() {
    // C9：收藏家按"拥有"计数（掉落 ∪ 成长解锁）——4 掉落 + bond 300 成长解锁 code_crown = 5
    let mut pet = day_pet(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.bond = 300;
    for def in pylon_pet_core::COSMETICS
        .iter()
        .filter(|d| matches!(d.unlock, pylon_pet_core::CosmeticUnlock::Drop))
        .take(4)
    {
        pet.inventory.push(def.id.to_string());
    }
    pet.apply(AiEvent::Visit, 1);
    assert!(
        pet.unlocked.contains(&"collector".to_string()),
        "4 掉落 + 成长解锁 code_crown = 5 件拥有，必须解锁收藏家: {:?}",
        pet.unlocked
    );
    // 对照：仅 3 掉落 + code_crown = 4 件，不满 5 不解锁
    let mut pet = day_pet(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.bond = 300;
    for def in pylon_pet_core::COSMETICS
        .iter()
        .filter(|d| matches!(d.unlock, pylon_pet_core::CosmeticUnlock::Drop))
        .take(3)
    {
        pet.inventory.push(def.id.to_string());
    }
    pet.apply(AiEvent::Visit, 1);
    assert!(
        !pet.unlocked.contains(&"collector".to_string()),
        "3 掉落 + code_crown = 4 件，不得解锁收藏家: {:?}",
        pet.unlocked
    );
}

#[test]
fn restore_backfills_achievements_for_old_saves() {
    // 模拟旧档：已达条件但从未触发解锁检查（unlocked 空）
    let mut pet = PetState::new_at(1);
    pet.unlocked = Vec::new();
    pet.stats.messages = 10;
    pet.stats.prompts_completed = 15;
    let restored = PetState::restore(pet, 100_000);
    assert!(
        restored.unlocked.contains(&"first_step".to_string()),
        "恢复必须补查 first_step"
    );
    assert!(
        restored.unlocked.contains(&"ten_tasks".to_string()),
        "恢复必须补查 ten_tasks"
    );
    assert!(
        !restored.unlocked.contains(&"hundred_tasks".to_string()),
        "15 次任务不满 100"
    );
    // 恢复文案优先（成就补查不覆盖"又亮起来了"）
    assert!(
        restored.msg.as_deref().unwrap_or("").contains("又亮起来了"),
        "恢复文案必须保留: {:?}",
        restored.msg
    );
}

#[test]
fn achievement_catalog_lists_all_with_unlocked_flags() {
    use pylon_pet_core::ACHIEVEMENTS;
    let mut pet = PetState::new_at(1);
    pet.unlocked = vec!["first_step".into(), "night_watcher".into()];
    let info = pet.achievement_info();
    assert_eq!(info.len(), ACHIEVEMENTS.len(), "目录必须与定义表一致");
    let first = info
        .iter()
        .find(|a| a.id == "first_step")
        .expect("目录含 first_step");
    assert!(first.unlocked);
    assert!(!first.name.is_empty());
    let locked = info
        .iter()
        .find(|a| a.id == "luminary")
        .expect("目录含 luminary");
    assert!(!locked.unlocked);
    // 全量目录 ≥ 20（用户要求 20+）
    assert!(
        ACHIEVEMENTS.len() >= 20,
        "成就数量必须 20+，实际 {}",
        ACHIEVEMENTS.len()
    );
    // id 唯一性
    let mut ids: Vec<&str> = ACHIEVEMENTS.iter().map(|a| a.id).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), ACHIEVEMENTS.len(), "成就 id 必须唯一");
}

// ── M10：装扮（掉落 / 冷却 / 装备 / 成长解锁）──

#[test]
fn cosmetic_drop_requires_lucky_roll_and_auto_equips() {
    let mut pet = day_pet(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    // roll=0（千分位 0 < 10）→ 掉落
    assert!(pet.maybe_drop_cosmetic(1, 0), "roll=0 必须掉落");
    assert_eq!(pet.inventory.len(), 1, "掉落入栏");
    assert!(pet.equipped.is_some(), "掉落自动装备");
    assert_eq!(pet.stats.cosmetics_collected, 1);
    assert!(
        pet.msg.as_deref().unwrap_or("").contains("戴上"),
        "首掉落文案应为戴上: {:?}",
        pet.msg
    );
    assert!(
        pet.memories.iter().any(|m| m.contains("捡到")),
        "掉落必须记入记忆"
    );
    assert!(
        pet.msg.as_deref().unwrap_or("").contains("捡到"),
        "掉落必须有文案: {:?}",
        pet.msg
    );
    assert!(pet.last_drop_at_ms > 0, "掉落必须记录冷却时间戳");
    // roll 不中（千分位 50 ≥ 10）→ 不掉
    let mut pet = day_pet(1);
    assert!(!pet.maybe_drop_cosmetic(1, 50), "roll=50 不掉落");
    assert!(pet.inventory.is_empty());
    // 边界：roll=9 掉、roll=10 不掉（DROP_PROBABILITY_PERMILLE=10）
    let mut pet = day_pet(1);
    assert!(pet.maybe_drop_cosmetic(1, 9));
    let mut pet = day_pet(1);
    assert!(!pet.maybe_drop_cosmetic(1, 10));
}

#[test]
fn cosmetic_drop_has_24h_cooldown_and_full_collection_stops() {
    // 冷却：掉落后在 24h 内 roll=0 也不掉
    let mut pet = day_pet(1);
    assert!(pet.maybe_drop_cosmetic(1, 0));
    assert!(!pet.maybe_drop_cosmetic(2, 0), "冷却期内不得掉落");
    // 24h 后（86400_000+1）冷却解除
    assert!(pet.maybe_drop_cosmetic(86_400_001, 0), "冷却解除后可再掉落");
    // 全收集：掉落池 8 件全收 → roll=0 也不掉
    use pylon_pet_core::COSMETICS;
    let droppable_count = COSMETICS
        .iter()
        .filter(|d| matches!(d.unlock, pylon_pet_core::CosmeticUnlock::Drop))
        .count();
    let mut pet = day_pet(1);
    for (i, def) in COSMETICS
        .iter()
        .filter(|d| matches!(d.unlock, pylon_pet_core::CosmeticUnlock::Drop))
        .enumerate()
    {
        pet.inventory.push(def.id.to_string());
        pet.last_drop_at_ms = 0; // 每件掉落间不冷却（构造全收集场景）
        let _ = i;
    }
    assert_eq!(pet.inventory.len(), droppable_count);
    assert!(!pet.maybe_drop_cosmetic(2, 0), "全收集后掉率为 0");
}

#[test]
fn drop_does_not_override_manual_equip() {
    // C10：已有装备时掉落不再顶掉手动装备（收进光里，待手动换装）
    let mut pet = day_pet(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    assert!(pet.maybe_drop_cosmetic(1, 0), "首掉落");
    let first = pet.equipped.clone().expect("首掉落自动装备");
    // 冷却解除后第二次掉落：equipped 保持 first 不变
    assert!(pet.maybe_drop_cosmetic(86_400_001, 0), "冷却解除后可再掉落");
    assert_eq!(pet.inventory.len(), 2, "两件都入栏");
    assert_eq!(
        pet.equipped.as_deref(),
        Some(first.as_str()),
        "掉落不得顶掉已有装备"
    );
    assert!(
        pet.msg.as_deref().unwrap_or("").contains("收进光里"),
        "已装备时掉落文案应为收进光里: {:?}",
        pet.msg
    );
    // 手动卸下后再次掉落 → 重新自动装备
    pet.unequip();
    assert!(pet.maybe_drop_cosmetic(2 * 86_400_001, 0), "卸下后可再掉落");
    assert!(pet.equipped.is_some(), "未装备时掉落自动戴上");
}

#[test]
fn equip_requires_ownership_and_growth_unlocks_work() {
    let mut pet = day_pet(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    // 未拥有 → 报错
    assert!(pet.equip("beret").is_err(), "未掉落不可装备");
    assert!(pet.equip("unknown_item").is_err(), "未知 id 报错");
    // 掉落一件 → 可装备
    pet.maybe_drop_cosmetic(1, 0);
    let owned = pet.inventory[0].clone();
    assert!(pet.equip(&owned).is_ok(), "已拥有可装备");
    assert_eq!(pet.equipped.as_deref(), Some(owned.as_str()));
    // 成长解锁（确定性）：bond<300 不可装备 code_crown；bond≥300 可
    let mut pet = day_pet(1);
    pet.bond = 100;
    assert!(
        pet.equip("code_crown").is_err(),
        "bond 不足不可装备成长装扮"
    );
    pet.bond = 300;
    assert!(pet.equip("code_crown").is_ok(), "bond≥300 可装备代码之冕");
    assert_eq!(pet.equipped.as_deref(), Some("code_crown"));
    // 阶段解锁：Luminary 才能装备长明之翼
    let mut pet = day_pet(1);
    pet.xp = 500;
    assert!(pet.equip("luminary_wings").is_ok(), "长明体可装备长明之翼");
    let mut pet = day_pet(1);
    pet.xp = 100;
    assert!(
        pet.equip("luminary_wings").is_err(),
        "低阶段不可装备长明之翼"
    );
    // 卸下
    pet.maybe_drop_cosmetic(1, 0);
    pet.unequip();
    assert!(pet.equipped.is_none(), "卸下后无装备");
}

#[test]
fn cosmetic_catalog_lists_all_with_owned_flags() {
    use pylon_pet_core::{CosmeticUnlock, COSMETICS};
    let mut pet = day_pet(1);
    // 掉落入栏一件
    pet.maybe_drop_cosmetic(1, 0);
    let info = pet.cosmetic_info();
    assert_eq!(info.len(), COSMETICS.len(), "目录必须与定义表一致");
    let owned_dropped = info
        .iter()
        .find(|c| c.id == pet.inventory[0])
        .expect("目录含掉落物品");
    assert!(owned_dropped.owned);
    // 成长解锁按条件标记 owned（bond≥300 → code_crown owned）
    let crown = info
        .iter()
        .find(|c| c.id == "code_crown")
        .expect("目录含代码之冕");
    assert!(!crown.owned);
    pet.bond = 300;
    let info = pet.cosmetic_info();
    let crown = info.iter().find(|c| c.id == "code_crown").unwrap();
    assert!(crown.owned, "bond≥300 后 code_crown 标记 owned");
    // id 唯一 + 掉落/成长分类齐备
    let mut ids: Vec<&str> = COSMETICS.iter().map(|c| c.id).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), COSMETICS.len(), "装扮 id 必须唯一");
    let drops = COSMETICS
        .iter()
        .filter(|d| matches!(d.unlock, CosmeticUnlock::Drop))
        .count();
    let growth = COSMETICS.len() - drops;
    assert!(drops >= 5, "掉落类至少 5 件: {drops}");
    assert!(growth >= 2, "成长解锁至少 2 件: {growth}");
}

#[test]
fn old_save_without_cosmetic_fields_loads_safely() {
    // 旧档（无 inventory/equipped/unlocked/last_drop_at_ms 字段）→ serde default 补齐
    let legacy = r#"{"name":"微栖","mood":"idle","happiness":65,"energy":80,"xp":0,"bond":0,
        "born_at_ms":1,"last_seen_day":0,"first_chunk_at_ms":null,"hunger":80,"fun":70,
        "loneliness":0,"traits":{"activity":50,"clinginess":50,"greed":50,"curiosity":50},
        "machine":"awake.idle","last_tick_at_ms":1,"recent_events":[],"last_agent_mode":null,
        "last_agent_model":null,"pending_action":null,"stats":{},"memories":[]}"#;
    let loaded: PetState = serde_json::from_str(legacy).expect("旧档必须可加载");
    assert!(loaded.inventory.is_empty());
    assert!(loaded.equipped.is_none());
    assert!(loaded.unlocked.is_empty());
    assert_eq!(loaded.last_drop_at_ms, 0);
    assert_eq!(loaded.stats.feed_count, 0, "旧档新计数 default 0");
}
