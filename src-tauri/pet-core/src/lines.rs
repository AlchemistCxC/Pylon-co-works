//! 文案池（M6，配套 docs/宠物文案库.md 的核心子集）。
//!
//! 选取机制：每个场景一个池（2-3 句），轮换索引避免连续重复；
//! 紧急需求文案无冷却（由 poll_voice 频率天然限流）。

/// 文案场景 key。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKey {
    Birth,
    Sleep,
    Wake,
    Dazed,
    Hungry,
    Lonely,
    Tired,
    Bored,
    Poke,
    Feed,
    Play,
    Rename,
    UserSent,
    FirstChunk,
    Done,
    Failed,
    FriendStart,
    FriendDone,
}

/// 抽取文案（轮换索引推进；idx 溢出回绕）。
pub fn pick(key: LineKey, idx: &mut u8) -> String {
    let pool: &[&str] = match key {
        LineKey::Birth => &["一粒微光落在了这里。", "它在代码的缝隙里睁开了眼。"],
        LineKey::Sleep => &["它蜷成一小团等待。", "困意像一行注释，把它包了起来。"],
        LineKey::Wake => &["它被你的脚步声唤醒。", "光重新亮起，它伸了个懒腰（如果有腰的话）。"],
        LineKey::Dazed => &["它望着空气发呆。", "它盯着一个不存在的进度条。"],
        LineKey::Hungry => &["咕……", "它饿得光都变弱了。"],
        LineKey::Lonely => &["你很久没理我了。", "它坐在屏幕角落，假装在看书。"],
        LineKey::Tired => &["它打了个哈欠——如果有嘴的话。", "它的光一眨一眨，快撑不住了。"],
        LineKey::Bored => &["它扒拉屏幕边缘。", "它开始数你自己都忘了的快捷键。"],
        LineKey::Poke => &["它贴近了你的指尖。", "它被戳得晃了晃，光更亮了。"],
        LineKey::Feed => &["能量沿着像素一格格亮起。", "它小口小口地吃掉光点，满意地眯眼。"],
        LineKey::Play => &["它追着你的光标跑来跑去。", "它和屏幕上的尘埃玩起了捉迷藏。"],
        LineKey::Rename => &["它记住了名字：", "它把新名字在光里转了一圈。"],
        LineKey::UserSent => &["它追着新的想法望了过去。", "它竖起光触角（如果有的话）。"],
        LineKey::FirstChunk => &["微光开始流动。", "它凑近屏幕，光兴奋地颤了颤。"],
        LineKey::Done => &["它把这次完成收进了身体。", "它像编译通过一样亮了起来。"],
        LineKey::Failed => &["光暗了一下，但没有熄灭。", "它歪着头，像看着一段报错的代码。"],
        LineKey::FriendStart => &["它认真起来：agent 在找帮手！它拿出了一团光。", "它开始搓一团光——它在捏朋友！"],
        LineKey::FriendDone => &["看！它捏了个幻影朋友。", "新朋友在旁边闪着同样的光。它俩并排坐着，像两行对齐的代码。"],
    };
    let pick_idx = *idx as usize % pool.len();
    *idx = idx.wrapping_add(1);
    let text = pool[pick_idx];
    if key == LineKey::Rename {
        format!("{text}") // 调用方拼名字
    } else {
        text.to_string()
    }
}
