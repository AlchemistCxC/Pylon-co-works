//! #488 批②：有意跨 `.await` 持锁的守卫收口类型。
//!
//! ## 背景
//!
//! 仓库根 `clippy.toml` 把 tokio 锁卫全家族列入 `await-holding-invalid-types`
//! （#414）——这是正确的默认：跨 `.await` 持锁会让其它任务在锁上排队（读锁饿死
//! 写者、写锁/Mutex 串行化全部任务），属性能反模式。
//!
//! 但本仓确有一批临界区的**串行化正是语义本身**（LifecycleOp 状态机的
//! switch/reconnect/restart、会话建立与 close、配置/审批/宠物的「读→改→写盘→
//! 提交」写序事务、gateway 实例生命周期迁移）：它们靠跨 `.await` 持锁保证
//! 「检查 → 副作用 → 提交」整窗不被并发插入。对这些点，正确的动作不是拆锁
//! （拆锁即改时序，被维护地图「锁外副作用时序不得变」红线禁止），而是**显式
//! 声明意图**。
//!
//! ## 契约
//!
//! 把守卫包进 [`HeldAcrossAwait`] 即是显式 opt-in：clippy 只对裸锁卫报警，
//! 包进来的守卫不再命中 lint；每处使用点必须保留锁序注释（持有的锁名 +
//! 为什么串行化是语义）。使用纪律由 `scripts/check-await-holding.mjs` 机械
//! 保障：对 `await_holding_invalid_type` 的裸 allow 全仓禁止，wrapper
//! 使用点对账清单登记。
//!
//! Drop 语义与内层守卫完全一致（newtype 透传，无 Drop 实现），锁获取/释放
//! 时序零变化——这是本类型唯一允许的用法：**包住既有的守卫绑定，不改任何
//! 加锁/放锁语句的结构**。

/// 有意跨 `.await` 持有的锁卫。见[模块文档][self]——纪律、理由与机械保障。
///
/// 用法：`let _guard = HeldAcrossAwait::new(state.switch_lock.lock().await);`
/// 之后对 `_guard` 的解引用与原来对裸守卫的解引用一致；绑定的 drop 时机
/// （作用域尾 / 显式 `drop`）也与裸守卫一致。
#[derive(Debug)]
pub struct HeldAcrossAwait<T>(T);

impl<T> HeldAcrossAwait<T> {
    /// 包住一个已获取的锁卫。**必须在守卫产生的同一语句内包裹**（中间不得有
    /// `.await`，否则裸守卫已跨 await、lint 在包裹前就会命中）。
    #[inline]
    pub fn new(guard: T) -> Self {
        Self(guard)
    }

    /// 取回内层守卫（用于需要按值传递的场合；不影响 drop 语义）。
    #[inline]
    pub fn into_inner(self) -> T {
        self.0
    }
}

impl<T: std::ops::Deref> std::ops::Deref for HeldAcrossAwait<T> {
    type Target = T::Target;

    #[inline]
    fn deref(&self) -> &Self::Target {
        self.0.deref()
    }
}

impl<T: std::ops::DerefMut> std::ops::DerefMut for HeldAcrossAwait<T> {
    #[inline]
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.0.deref_mut()
    }
}
