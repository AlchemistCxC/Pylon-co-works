use pylon_pet_core::{AiEvent, GrowthStage, PetState, ToolOutcome};

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
fn sleepy_pet_is_woken_by_daily_visit() {
    let mut pet = PetState::new_at(0);
    pet.apply(AiEvent::FirstChunk, 1);
    assert!(pet.check_sleepy(31_000), "30s idle after first chunk must fall asleep");
    assert_eq!(pet.mood, "sleepy");

    pet.apply(AiEvent::Visit, 31_001);
    assert_eq!(pet.mood, "idle", "daily visit must wake a sleeping pet");
    assert_eq!(pet.msg.as_deref(), Some("它被你的脚步声唤醒。"));
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

    let mut pet = PetState::new_at(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.apply(AiEvent::Play, 1);
    assert_eq!(pet.fun, 95, "play 恢复 fun +25");
    assert_eq!(pet.loneliness, 0, "play 大幅降低孤独");
    assert_eq!(pet.energy, 70, "play 消耗 energy -10");
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
    // 睡眠中 30 分钟：energy +60 恢复；随后任何互动唤醒（wake 再 +30）
    pet.apply(AiEvent::Visit, 31_000 + 1_800_000);
    assert_eq!(pet.machine, pylon_pet_core::PetMachineState::Awake(pylon_pet_core::MachineSub::Idle), "Visit 唤醒睡眠中的宠物");
    assert_eq!(pet.energy, 100, "睡眠恢复 60 + 唤醒加成 30 = 100（封顶）");
}

#[test]
fn force_sleep_when_energy_hits_zero() {
    let mut pet = PetState::new_at(1);
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
    let mut pet = PetState::new_at(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.apply(AiEvent::Play, 1);
    assert_eq!(pet.bond, 3, "首次玩耍 +3 bond");
    pet.apply(AiEvent::Play, 2);
    assert_eq!(pet.bond, 3, "60s 内重复玩耍不加 bond");
    pet.apply(AiEvent::Play, 60_002);
    assert_eq!(pet.bond, 6, "冷却后再次 +3");
}

#[test]
fn greedy_pet_gets_more_from_food() {
    let mut pet = PetState::new_at(1);
    pet.traits = pylon_pet_core::PetTraits::default();
    pet.traits.greed = 100;
    pet.hunger = 50;
    pet.apply(AiEvent::Feed, 1);
    assert_eq!(pet.hunger, 80, "贪吃喂食收益 ×1.5（+30）");
    let mut normal = PetState::new_at(1);
    normal.traits = pylon_pet_core::PetTraits::default();
    normal.hunger = 50;
    normal.apply(AiEvent::Feed, 1);
    assert_eq!(normal.hunger, 70, "普通喂食 +20");
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
