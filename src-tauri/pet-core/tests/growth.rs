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
