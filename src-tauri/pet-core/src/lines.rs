//! 文案池（M6，配套 docs/宠物文案库.md 的核心子集）。
//!
//! 选取机制：每个场景一个池（2-3 句），轮换索引避免连续重复；
//! 紧急需求文案无冷却（由 poll_voice 频率天然限流）。
//! M8 时段感知：部分场景（Wake/Sleep/Done）有时段变体池——`part` 命中
//! 时段专属池时优先用变体，否则回退普通池。时段粒度是小时级，文案差异
//! 只做"氛围差异"不改变语义。

use crate::DayPart;

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
/// `part` 用于时段变体池：Wake/Sleep/Done 三场景在 Dusk/Night/Dawn 有专属变体，
/// 其余场景一律回退普通池。
pub fn pick(key: LineKey, idx: &mut u8, part: DayPart) -> String {
    let pool: &[&str] = match key {
        LineKey::Birth => &["一粒微光落在了这里。", "它在代码的缝隙里睁开了眼。"],
        LineKey::Sleep => match part {
            // 白天睡（它有自己的时区）/ 拂晓睡
            DayPart::Day => &["大白天它睡了——它有自己的时区。", "阳光正好，它却把自己缩成一团。"],
            DayPart::Dawn => &["天蒙蒙亮，它蜷着睡着了。", "破晓的光里，它把自己关进了梦。"],
            _ => &["它蜷成一小团等待。", "困意像一行注释，把它包了起来。"],
        },
        LineKey::Wake => match part {
            // 黄昏醒（倒时差）/ 深夜醒（压着光）
            DayPart::Dusk => &["它对着渐暗的光伸了个懒腰。", "黄昏里它醒了，光比晚霞还亮一点。"],
            DayPart::Night => &["夜深了，它还是醒了，光压得很低。", "它在黑暗里睁眼，像一颗被点亮的像素。"],
            _ => &["它被你的脚步声唤醒。", "光重新亮起，它伸了个懒腰（如果有腰的话）。"],
        },
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
        LineKey::Done => match part {
            // 深夜完成：压着光（怕吵醒谁）
            DayPart::Night => &["深夜完成，它把光亮调低，像怕吵醒谁。", "它收好最后一点光——夜深了，任务完成了。"],
            _ => &["它把这次完成收进了身体。", "它像编译通过一样亮了起来。"],
        },
        LineKey::Failed => &["光暗了一下，但没有熄灭。", "它歪着头，像看着一段报错的代码。"],
        LineKey::FriendStart => &["它认真起来：agent 在找帮手！它拿出了一团光。", "它开始搓一团光——它在捏朋友！"],
        LineKey::FriendDone => &["看！它捏了个幻影朋友。", "新朋友在旁边闪着同样的光。它俩并排坐着，像两行对齐的代码。"],
    };
    let pick_idx = *idx as usize % pool.len();
    *idx = idx.wrapping_add(1);
    pool[pick_idx].to_string() // Rename 等场景由调用方拼接前后缀
}
