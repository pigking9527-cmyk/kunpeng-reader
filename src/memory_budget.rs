//! 进程内缓存和大块临时分配的统一内存治理。
//!
//! [`plan`] 保留原来的静态软配额视图；实际分配应通过 [`governor`] 申请
//! [`MemoryPermit`]。各类可以在总量有空闲时借用彼此的软配额，但所有并发申请
//! 都受同一个硬上限约束。缓存还可以注册回收器，在硬上限不足时按超额程度回收。

use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;
const MAX_CACHE_BYTES: u64 = 6 * GIB;
const MEMORY_CLASS_COUNT: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RuntimeMemoryBudget {
    pub(crate) total_physical_bytes: u64,
    pub(crate) available_bytes_at_start: u64,
    pub(crate) cache_total_bytes: u64,
    pub(crate) search_text_bytes: u64,
    pub(crate) search_filter_bytes: u64,
    pub(crate) semantic_vector_bytes: u64,
    pub(crate) semantic_graph_bytes: u64,
    pub(crate) semantic_aux_bytes: u64,
}

impl RuntimeMemoryBudget {
    pub(crate) fn from_memory(total: u64, available: u64) -> Self {
        // 给模型、WebView、系统和临时建图内存预留空间。预算既受物理内存约束，
        // 也受启动时真正可用内存约束；可用内存很低时不会用“最低值”反向超配。
        let reserve = if total >= 16 * GIB {
            3 * GIB
        } else if total >= 8 * GIB {
            1536 * MIB
        } else {
            768 * MIB
        };
        let spendable = available.saturating_sub(reserve);
        let proportional = (total / 4).min(spendable / 2).min(MAX_CACHE_BYTES);
        let cache_total = proportional.max((128 * MIB).min(spendable));

        let search_text = cache_total * 20 / 100;
        let search_filter = cache_total * 5 / 100;
        let semantic_vector = cache_total * 30 / 100;
        let semantic_aux = cache_total * 5 / 100;
        let semantic_graph = cache_total
            .saturating_sub(search_text)
            .saturating_sub(search_filter)
            .saturating_sub(semantic_vector)
            .saturating_sub(semantic_aux);

        Self {
            total_physical_bytes: total,
            available_bytes_at_start: available,
            cache_total_bytes: cache_total,
            search_text_bytes: search_text,
            search_filter_bytes: search_filter,
            semantic_vector_bytes: semantic_vector,
            semantic_graph_bytes: semantic_graph,
            semantic_aux_bytes: semantic_aux,
        }
    }

    fn soft_limit(self, class: MemoryClass) -> u64 {
        match class {
            MemoryClass::SearchText => self.search_text_bytes,
            MemoryClass::SearchFilter => self.search_filter_bytes,
            MemoryClass::SemanticVector => self.semantic_vector_bytes,
            MemoryClass::SemanticGraph => self.semantic_graph_bytes,
            MemoryClass::SemanticAux => self.semantic_aux_bytes,
        }
    }
}

/// 可独立统计、带软配额的内存使用类别。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum MemoryClass {
    SearchText,
    SearchFilter,
    SemanticVector,
    SemanticGraph,
    SemanticAux,
}

impl MemoryClass {
    pub(crate) const ALL: [Self; MEMORY_CLASS_COUNT] = [
        Self::SearchText,
        Self::SearchFilter,
        Self::SemanticVector,
        Self::SemanticGraph,
        Self::SemanticAux,
    ];

    const fn index(self) -> usize {
        match self {
            Self::SearchText => 0,
            Self::SearchFilter => 1,
            Self::SemanticVector => 2,
            Self::SemanticGraph => 3,
            Self::SemanticAux => 4,
        }
    }
}

/// 常驻缓存和可在一次操作结束后释放的临时内存分开计数。
#[allow(dead_code)] // 供各缓存逐步迁移到共享 Permit API。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MemoryUsageKind {
    Resident,
    Transient,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct MemoryClassUsage {
    pub(crate) soft_limit_bytes: u64,
    pub(crate) resident_bytes: u64,
    pub(crate) transient_bytes: u64,
    pub(crate) borrowed_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MemoryGovernorSnapshot {
    pub(crate) hard_limit_bytes: u64,
    pub(crate) committed_bytes: u64,
    pub(crate) resident_bytes: u64,
    pub(crate) transient_bytes: u64,
    pub(crate) available_bytes: u64,
    pub(crate) classes: [MemoryClassUsage; MEMORY_CLASS_COUNT],
    pub(crate) reclaim_attempts: u64,
    pub(crate) reclaimed_bytes: u64,
    pub(crate) denied_requests: u64,
}

impl MemoryGovernorSnapshot {
    pub(crate) fn class(&self, class: MemoryClass) -> MemoryClassUsage {
        self.classes[class.index()]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ReclaimRequest {
    pub(crate) requested_by: MemoryClass,
    pub(crate) target_class: MemoryClass,
    pub(crate) bytes_needed: u64,
    pub(crate) target_over_soft_bytes: u64,
    pub(crate) committed_bytes: u64,
    pub(crate) hard_limit_bytes: u64,
}

type ReclaimCallback = dyn Fn(ReclaimRequest) + Send + Sync + 'static;

#[derive(Clone)]
#[allow(dead_code)] // 正式缓存接入前，注册标识只由句柄注销路径读取。
struct Reclaimer {
    id: u64,
    class: MemoryClass,
    callback: Arc<ReclaimCallback>,
}

#[derive(Clone, Copy, Debug, Default)]
struct ClassCounters {
    resident: u64,
    transient: u64,
}

impl ClassCounters {
    fn committed(self) -> u64 {
        self.resident.saturating_add(self.transient)
    }
}

#[derive(Debug)]
struct GovernorState {
    classes: [ClassCounters; MEMORY_CLASS_COUNT],
    reclaim_attempts: u64,
    reclaimed_bytes: u64,
    denied_requests: u64,
}

impl Default for GovernorState {
    fn default() -> Self {
        Self {
            classes: [ClassCounters::default(); MEMORY_CLASS_COUNT],
            reclaim_attempts: 0,
            reclaimed_bytes: 0,
            denied_requests: 0,
        }
    }
}

impl GovernorState {
    fn committed(&self) -> u64 {
        self.classes
            .iter()
            .fold(0_u64, |sum, class| sum.saturating_add(class.committed()))
    }
}

/// 一次申请失败的精确原因。失败不会改变任何计数。
#[allow(dead_code)] // 供各缓存逐步迁移到共享 Permit API。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum MemoryBudgetError {
    RequestExceedsHardLimit {
        requested_bytes: u64,
        hard_limit_bytes: u64,
    },
    InsufficientBudget {
        requested_bytes: u64,
        committed_bytes: u64,
        hard_limit_bytes: u64,
    },
}

impl fmt::Display for MemoryBudgetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RequestExceedsHardLimit {
                requested_bytes,
                hard_limit_bytes,
            } => write!(
                f,
                "单次内存申请 {requested_bytes} 字节超过硬上限 {hard_limit_bytes} 字节"
            ),
            Self::InsufficientBudget {
                requested_bytes,
                committed_bytes,
                hard_limit_bytes,
            } => write!(
                f,
                "内存预算不足：申请 {requested_bytes} 字节，已占用 {committed_bytes}/{hard_limit_bytes} 字节"
            ),
        }
    }
}

impl std::error::Error for MemoryBudgetError {}

/// 所有缓存/任务共享的硬上限和实时计数器。
#[allow(dead_code)] // next_reclaimer_id 在缓存注册回收器后进入生产路径。
pub(crate) struct MemoryGovernor {
    budget: RuntimeMemoryBudget,
    state: Mutex<GovernorState>,
    reclaimers: Mutex<Vec<Reclaimer>>,
    // 串行化回收，避免多个并发申请同时清扫同一缓存。回调不得同步再次申请本治理器。
    reclaim_gate: Mutex<()>,
    next_reclaimer_id: AtomicU64,
}

#[allow(dead_code)] // Permit/回收器 API 将由缓存模块逐个接入。
impl MemoryGovernor {
    pub(crate) fn new(budget: RuntimeMemoryBudget) -> Self {
        Self {
            budget,
            state: Mutex::new(GovernorState::default()),
            reclaimers: Mutex::new(Vec::new()),
            reclaim_gate: Mutex::new(()),
            next_reclaimer_id: AtomicU64::new(1),
        }
    }

    pub(crate) fn hard_limit_bytes(&self) -> u64 {
        self.budget.cache_total_bytes
    }

    pub(crate) fn soft_limit_bytes(&self, class: MemoryClass) -> u64 {
        self.budget.soft_limit(class)
    }

    /// 申请内存。软配额允许跨类别借用，硬上限则在同一把锁下原子检查并计费。
    pub(crate) fn try_acquire(
        self: &Arc<Self>,
        class: MemoryClass,
        kind: MemoryUsageKind,
        bytes: u64,
    ) -> Result<MemoryPermit, MemoryBudgetError> {
        if bytes > self.hard_limit_bytes() {
            self.record_denial();
            return Err(MemoryBudgetError::RequestExceedsHardLimit {
                requested_bytes: bytes,
                hard_limit_bytes: self.hard_limit_bytes(),
            });
        }

        if self.try_charge(class, kind, bytes) {
            return Ok(MemoryPermit::new(Arc::clone(self), class, kind, bytes));
        }

        // 只有真正碰到硬上限才启动回收；低于硬上限时允许自然借用空闲软配额。
        let _reclaim_guard = lock_unpoisoned(&self.reclaim_gate);
        if self.try_charge(class, kind, bytes) {
            return Ok(MemoryPermit::new(Arc::clone(self), class, kind, bytes));
        }
        let committed_before = self.committed_bytes();
        let needed = committed_before
            .saturating_add(bytes)
            .saturating_sub(self.hard_limit_bytes());
        self.run_reclaimers(class, needed);

        if self.try_charge(class, kind, bytes) {
            return Ok(MemoryPermit::new(Arc::clone(self), class, kind, bytes));
        }

        let committed = self.committed_bytes();
        self.record_denial();
        Err(MemoryBudgetError::InsufficientBudget {
            requested_bytes: bytes,
            committed_bytes: committed,
            hard_limit_bytes: self.hard_limit_bytes(),
        })
    }

    /// 主动要求缓存至少回收 `target_bytes`。实际释放量来自 Permit 的 Drop，
    /// 回调的返回值不会被信任，因此统计不会与真实占用漂移。
    #[allow(dead_code)] // 接入缓存的主动内存压力处理后由调用方使用。
    pub(crate) fn reclaim(self: &Arc<Self>, requested_by: MemoryClass, target_bytes: u64) -> u64 {
        if target_bytes == 0 {
            return 0;
        }
        let _reclaim_guard = lock_unpoisoned(&self.reclaim_gate);
        self.run_reclaimers(requested_by, target_bytes)
    }

    /// 注册缓存回收器。回调应删除缓存项并让对应 [`MemoryPermit`] 离开作用域；
    /// 不要在回调中同步调用 `try_acquire`，否则会与串行回收门互相等待。
    pub(crate) fn register_reclaimer<F>(
        self: &Arc<Self>,
        class: MemoryClass,
        callback: F,
    ) -> ReclaimerHandle
    where
        F: Fn(ReclaimRequest) + Send + Sync + 'static,
    {
        let id = self.next_reclaimer_id.fetch_add(1, Ordering::Relaxed);
        lock_unpoisoned(&self.reclaimers).push(Reclaimer {
            id,
            class,
            callback: Arc::new(callback),
        });
        ReclaimerHandle {
            governor: Arc::downgrade(self),
            id,
        }
    }

    pub(crate) fn snapshot(&self) -> MemoryGovernorSnapshot {
        let state = lock_unpoisoned(&self.state);
        let mut resident = 0_u64;
        let mut transient = 0_u64;
        let mut classes = [MemoryClassUsage::default(); MEMORY_CLASS_COUNT];
        for class in MemoryClass::ALL {
            let counters = state.classes[class.index()];
            resident = resident.saturating_add(counters.resident);
            transient = transient.saturating_add(counters.transient);
            let soft_limit = self.soft_limit_bytes(class);
            classes[class.index()] = MemoryClassUsage {
                soft_limit_bytes: soft_limit,
                resident_bytes: counters.resident,
                transient_bytes: counters.transient,
                borrowed_bytes: counters.committed().saturating_sub(soft_limit),
            };
        }
        let committed = resident.saturating_add(transient);
        MemoryGovernorSnapshot {
            hard_limit_bytes: self.hard_limit_bytes(),
            committed_bytes: committed,
            resident_bytes: resident,
            transient_bytes: transient,
            available_bytes: self.hard_limit_bytes().saturating_sub(committed),
            classes,
            reclaim_attempts: state.reclaim_attempts,
            reclaimed_bytes: state.reclaimed_bytes,
            denied_requests: state.denied_requests,
        }
    }

    fn try_charge(&self, class: MemoryClass, kind: MemoryUsageKind, bytes: u64) -> bool {
        let mut state = lock_unpoisoned(&self.state);
        if state.committed().saturating_add(bytes) > self.hard_limit_bytes() {
            return false;
        }
        let counters = &mut state.classes[class.index()];
        match kind {
            MemoryUsageKind::Resident => {
                counters.resident = counters.resident.saturating_add(bytes)
            }
            MemoryUsageKind::Transient => {
                counters.transient = counters.transient.saturating_add(bytes)
            }
        }
        true
    }

    fn release(&self, class: MemoryClass, kind: MemoryUsageKind, bytes: u64) {
        let mut state = lock_unpoisoned(&self.state);
        let counters = &mut state.classes[class.index()];
        let counter = match kind {
            MemoryUsageKind::Resident => &mut counters.resident,
            MemoryUsageKind::Transient => &mut counters.transient,
        };
        debug_assert!(*counter >= bytes, "MemoryPermit 释放量超过已登记量");
        *counter = counter.saturating_sub(bytes);
    }

    fn committed_bytes(&self) -> u64 {
        lock_unpoisoned(&self.state).committed()
    }

    fn record_denial(&self) {
        let mut state = lock_unpoisoned(&self.state);
        state.denied_requests = state.denied_requests.saturating_add(1);
    }

    fn run_reclaimers(&self, requested_by: MemoryClass, target_bytes: u64) -> u64 {
        if target_bytes == 0 {
            return 0;
        }
        let before = self.committed_bytes();
        {
            let mut state = lock_unpoisoned(&self.state);
            state.reclaim_attempts = state.reclaim_attempts.saturating_add(1);
        }

        let snapshot = self.snapshot();
        let mut reclaimers = lock_unpoisoned(&self.reclaimers).clone();
        // 先清理超过软配额最多的类；同等情况下先清理非请求类，减少抖动。
        reclaimers.sort_by(|left, right| {
            let left_over = snapshot.class(left.class).borrowed_bytes;
            let right_over = snapshot.class(right.class).borrowed_bytes;
            right_over
                .cmp(&left_over)
                .then_with(|| (left.class == requested_by).cmp(&(right.class == requested_by)))
        });

        for reclaimer in reclaimers {
            let now = self.committed_bytes();
            let freed = before.saturating_sub(now);
            if freed >= target_bytes {
                break;
            }
            let target_usage = self.snapshot().class(reclaimer.class);
            let request = ReclaimRequest {
                requested_by,
                target_class: reclaimer.class,
                bytes_needed: target_bytes.saturating_sub(freed),
                target_over_soft_bytes: target_usage.borrowed_bytes,
                committed_bytes: now,
                hard_limit_bytes: self.hard_limit_bytes(),
            };
            // 一个缓存回收器出错不能破坏全局计数或阻止其他缓存参与回收。
            let callback = Arc::clone(&reclaimer.callback);
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback(request)));
        }

        let freed = before.saturating_sub(self.committed_bytes());
        let mut state = lock_unpoisoned(&self.state);
        state.reclaimed_bytes = state.reclaimed_bytes.saturating_add(freed);
        freed
    }

    fn unregister_reclaimer(&self, id: u64) {
        lock_unpoisoned(&self.reclaimers).retain(|entry| entry.id != id);
    }
}

/// 持有期间即计入全局硬上限，离开作用域自动归还。不可 Clone，避免重复释放。
#[must_use = "MemoryPermit 必须与实际内存对象保持相同生命周期"]
#[allow(dead_code)] // 供各缓存逐步迁移到共享 Permit API。
pub(crate) struct MemoryPermit {
    governor: Arc<MemoryGovernor>,
    class: MemoryClass,
    kind: MemoryUsageKind,
    bytes: u64,
}

#[allow(dead_code)] // 供各缓存逐步迁移到共享 Permit API。
impl MemoryPermit {
    fn new(
        governor: Arc<MemoryGovernor>,
        class: MemoryClass,
        kind: MemoryUsageKind,
        bytes: u64,
    ) -> Self {
        Self {
            governor,
            class,
            kind,
            bytes,
        }
    }

    pub(crate) fn bytes(&self) -> u64 {
        self.bytes
    }

    /// 缩小实际对象后同步缩小计费；增大对象请先用 [`try_grow`] 预留。
    pub(crate) fn shrink_to(&mut self, new_bytes: u64) {
        if new_bytes >= self.bytes {
            return;
        }
        let released = self.bytes - new_bytes;
        self.governor.release(self.class, self.kind, released);
        self.bytes = new_bytes;
    }

    pub(crate) fn try_grow(&mut self, additional_bytes: u64) -> Result<(), MemoryBudgetError> {
        if additional_bytes == 0 {
            return Ok(());
        }
        // 先以独立 Permit 原子计费，再把所有权合并到当前 Permit。
        let mut extra = self
            .governor
            .try_acquire(self.class, self.kind, additional_bytes)?;
        self.bytes = self.bytes.saturating_add(extra.bytes);
        extra.bytes = 0;
        Ok(())
    }
}

impl Drop for MemoryPermit {
    fn drop(&mut self) {
        if self.bytes != 0 {
            self.governor.release(self.class, self.kind, self.bytes);
            self.bytes = 0;
        }
    }
}

/// 保持此句柄即可保持回收器注册，Drop 时自动注销。
#[must_use = "必须保留 ReclaimerHandle，回收器才会持续注册"]
#[allow(dead_code)] // 供各缓存逐步迁移到共享回收器 API。
pub(crate) struct ReclaimerHandle {
    governor: Weak<MemoryGovernor>,
    id: u64,
}

impl Drop for ReclaimerHandle {
    fn drop(&mut self) {
        if let Some(governor) = self.governor.upgrade() {
            governor.unregister_reclaimer(self.id);
        }
    }
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn plan() -> &'static RuntimeMemoryBudget {
    static PLAN: OnceLock<RuntimeMemoryBudget> = OnceLock::new();
    PLAN.get_or_init(|| {
        let (total, available) = ram_total_available();
        RuntimeMemoryBudget::from_memory(total, available)
    })
}

#[allow(dead_code)] // 迁移各缓存到 Permit 时的统一进程级入口。
pub(crate) fn governor() -> &'static Arc<MemoryGovernor> {
    static GOVERNOR: OnceLock<Arc<MemoryGovernor>> = OnceLock::new();
    GOVERNOR.get_or_init(|| Arc::new(MemoryGovernor::new(*plan())))
}

pub(crate) fn memory_pressure_high() -> bool {
    let plan = plan();
    let (_, available) = ram_total_available();
    let pressure_floor = (plan.total_physical_bytes / 16).clamp(512 * MIB, 2 * GIB);
    available < pressure_floor
}

#[cfg(windows)]
pub(crate) fn ram_total_available() -> (u64, u64) {
    #[repr(C)]
    struct MemStatusEx {
        length: u32,
        mem_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page: u64,
        avail_page: u64,
        total_virt: u64,
        avail_virt: u64,
        avail_ext_virt: u64,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalMemoryStatusEx(status: *mut MemStatusEx) -> i32;
    }
    let mut status: MemStatusEx = unsafe { std::mem::zeroed() };
    status.length = std::mem::size_of::<MemStatusEx>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut status) } != 0 {
        (status.total_phys, status.avail_phys)
    } else {
        (8 * GIB, 4 * GIB)
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn ram_total_available() -> (u64, u64) {
    let Ok(meminfo) = std::fs::read_to_string("/proc/meminfo") else {
        return (8 * GIB, 4 * GIB);
    };
    let read_kib = |key: &str| -> Option<u64> {
        meminfo.lines().find_map(|line| {
            let value = line.strip_prefix(key)?.trim();
            value.split_whitespace().next()?.parse::<u64>().ok()
        })
    };
    match (read_kib("MemTotal:"), read_kib("MemAvailable:")) {
        (Some(total), Some(available)) => {
            (total.saturating_mul(1024), available.saturating_mul(1024))
        }
        _ => (8 * GIB, 4 * GIB),
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn ram_total_available() -> (u64, u64) {
    unsafe fn sysctl_u64(name: &'static [u8]) -> Option<u64> {
        let mut value = 0_u64;
        let mut size = std::mem::size_of::<u64>();
        let result = unsafe {
            libc::sysctlbyname(
                name.as_ptr().cast(),
                (&mut value as *mut u64).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        (result == 0 && size == std::mem::size_of::<u64>()).then_some(value)
    }

    let total = unsafe { sysctl_u64(b"hw.memsize\0") }.unwrap_or(8 * GIB);
    let mut statistics: libc::vm_statistics64 = unsafe { std::mem::zeroed() };
    let mut count = libc::HOST_VM_INFO64_COUNT;
    let status = unsafe {
        libc::host_statistics64(
            libc::mach_host_self(),
            libc::HOST_VM_INFO64,
            (&mut statistics as *mut libc::vm_statistics64).cast(),
            &mut count,
        )
    };
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if status == libc::KERN_SUCCESS && page_size > 0 {
        // inactive/speculative/purgeable pages can be reclaimed by the OS and
        // are therefore part of the memory available to a cache budget.
        let available_pages = u64::from(statistics.free_count)
            .saturating_add(u64::from(statistics.inactive_count))
            .saturating_add(u64::from(statistics.speculative_count))
            .saturating_add(u64::from(statistics.purgeable_count));
        (total, available_pages.saturating_mul(page_size as u64))
    } else {
        (total, total / 2)
    }
}

#[cfg(all(not(windows), not(target_os = "linux"), not(target_os = "macos")))]
pub(crate) fn ram_total_available() -> (u64, u64) {
    (8 * GIB, 4 * GIB)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, AtomicUsize};
    use std::sync::{Barrier, Mutex};
    use std::thread;
    use std::time::Duration;

    fn test_budget(total: u64) -> RuntimeMemoryBudget {
        RuntimeMemoryBudget {
            total_physical_bytes: total * 8,
            available_bytes_at_start: total * 4,
            cache_total_bytes: total,
            search_text_bytes: total * 20 / 100,
            search_filter_bytes: total * 5 / 100,
            semantic_vector_bytes: total * 30 / 100,
            semantic_graph_bytes: total * 40 / 100,
            semantic_aux_bytes: total.saturating_sub(total * 95 / 100),
        }
    }

    #[test]
    fn class_budgets_exactly_share_one_total() {
        let budget = RuntimeMemoryBudget::from_memory(32 * GIB, 20 * GIB);
        assert_eq!(budget.cache_total_bytes, 6 * GIB);
        assert_eq!(
            budget.search_text_bytes
                + budget.search_filter_bytes
                + budget.semantic_vector_bytes
                + budget.semantic_graph_bytes
                + budget.semantic_aux_bytes,
            budget.cache_total_bytes
        );
    }

    #[test]
    fn low_available_memory_never_gets_overcommitted_by_a_floor() {
        let budget = RuntimeMemoryBudget::from_memory(16 * GIB, 320 * MIB);
        assert_eq!(budget.cache_total_bytes, 0);
        assert_eq!(budget.semantic_graph_bytes, 0);
    }

    #[test]
    fn budget_shrinks_when_available_memory_shrinks() {
        let roomy = RuntimeMemoryBudget::from_memory(16 * GIB, 12 * GIB);
        let tight = RuntimeMemoryBudget::from_memory(16 * GIB, 4 * GIB);
        assert!(tight.cache_total_bytes < roomy.cache_total_bytes);
    }

    #[test]
    fn classes_borrow_unused_soft_quota_but_not_the_hard_limit() {
        let governor = Arc::new(MemoryGovernor::new(test_budget(100)));
        let permit = governor
            .try_acquire(MemoryClass::SearchText, MemoryUsageKind::Resident, 75)
            .expect("unused class quotas should be borrowable");
        let snapshot = governor.snapshot();
        assert_eq!(snapshot.committed_bytes, 75);
        assert_eq!(snapshot.class(MemoryClass::SearchText).borrowed_bytes, 55);
        assert!(matches!(
            governor.try_acquire(MemoryClass::SemanticGraph, MemoryUsageKind::Transient, 26),
            Err(MemoryBudgetError::InsufficientBudget { .. })
        ));
        drop(permit);
        assert_eq!(governor.snapshot().committed_bytes, 0);
    }

    #[test]
    fn resident_and_transient_are_counted_and_released_separately() {
        let governor = Arc::new(MemoryGovernor::new(test_budget(100)));
        let resident = governor
            .try_acquire(MemoryClass::SemanticVector, MemoryUsageKind::Resident, 30)
            .unwrap();
        let transient = governor
            .try_acquire(MemoryClass::SemanticGraph, MemoryUsageKind::Transient, 40)
            .unwrap();
        let snapshot = governor.snapshot();
        assert_eq!(snapshot.resident_bytes, 30);
        assert_eq!(snapshot.transient_bytes, 40);
        drop(transient);
        assert_eq!(governor.snapshot().transient_bytes, 0);
        drop(resident);
        assert_eq!(governor.snapshot().resident_bytes, 0);
    }

    #[test]
    fn reclaimer_drops_resident_permit_before_retrying_request() {
        let governor = Arc::new(MemoryGovernor::new(test_budget(100)));
        let cached = governor
            .try_acquire(MemoryClass::SemanticVector, MemoryUsageKind::Resident, 70)
            .unwrap();
        let cached = Arc::new(Mutex::new(Some(cached)));
        let callback_calls = Arc::new(AtomicUsize::new(0));
        let _handle = governor.register_reclaimer(MemoryClass::SemanticVector, {
            let cached = Arc::clone(&cached);
            let callback_calls = Arc::clone(&callback_calls);
            move |request| {
                assert_eq!(request.requested_by, MemoryClass::SemanticGraph);
                callback_calls.fetch_add(1, Ordering::SeqCst);
                lock_unpoisoned(&cached).take();
            }
        });
        let existing = governor
            .try_acquire(MemoryClass::SemanticAux, MemoryUsageKind::Transient, 30)
            .unwrap();
        let graph = governor
            .try_acquire(MemoryClass::SemanticGraph, MemoryUsageKind::Transient, 50)
            .expect("reclaimer should make the second attempt fit");
        assert_eq!(callback_calls.load(Ordering::SeqCst), 1);
        assert_eq!(governor.snapshot().reclaimed_bytes, 70);
        drop((graph, existing));
        assert_eq!(governor.snapshot().committed_bytes, 0);
    }

    #[test]
    fn permit_can_grow_and_shrink_without_counter_drift() {
        let governor = Arc::new(MemoryGovernor::new(test_budget(100)));
        let mut permit = governor
            .try_acquire(MemoryClass::SemanticAux, MemoryUsageKind::Transient, 20)
            .unwrap();
        permit.try_grow(30).unwrap();
        assert_eq!(permit.bytes(), 50);
        assert_eq!(governor.snapshot().committed_bytes, 50);
        permit.shrink_to(12);
        assert_eq!(governor.snapshot().committed_bytes, 12);
        drop(permit);
        assert_eq!(governor.snapshot().committed_bytes, 0);
    }

    #[test]
    fn concurrent_requests_never_cross_the_hard_limit() {
        const HARD_LIMIT: u64 = 64;
        const REQUEST: u64 = 16;
        const THREADS: usize = 16;
        let governor = Arc::new(MemoryGovernor::new(test_budget(HARD_LIMIT)));
        let barrier = Arc::new(Barrier::new(THREADS));
        let maximum = Arc::new(AtomicU64::new(0));
        let mut workers = Vec::new();
        for _ in 0..THREADS {
            let governor = Arc::clone(&governor);
            let barrier = Arc::clone(&barrier);
            let maximum = Arc::clone(&maximum);
            workers.push(thread::spawn(move || {
                barrier.wait();
                if let Ok(_permit) = governor.try_acquire(
                    MemoryClass::SemanticGraph,
                    MemoryUsageKind::Transient,
                    REQUEST,
                ) {
                    let committed = governor.snapshot().committed_bytes;
                    maximum.fetch_max(committed, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(5));
                }
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        assert!(maximum.load(Ordering::SeqCst) <= HARD_LIMIT);
        assert_eq!(governor.snapshot().committed_bytes, 0);
    }
}
