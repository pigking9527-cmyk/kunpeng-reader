//! Dedicated execution pool for CPU-heavy approximate-index construction.
//!
//! `instant-distance` uses Rayon internally.  Running it directly would use
//! Rayon's process-wide pool whose worker threads keep normal foreground
//! priority.  This pool leaves one logical CPU free (up to a practical cap) and
//! marks every worker as background work on Windows, keeping the reader UI
//! responsive while retaining parallel HNSW construction.

use rayon::{ThreadPool, ThreadPoolBuilder};
use std::sync::OnceLock;

static INDEX_POOL: OnceLock<Result<ThreadPool, String>> = OnceLock::new();

fn build_pool() -> Result<ThreadPool, String> {
    let available = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(4);
    let workers = available.saturating_sub(1).clamp(1, 12);
    ThreadPoolBuilder::new()
        .num_threads(workers)
        .thread_name(|index| format!("semantic-index-{index}"))
        .start_handler(|_| {
            crate::set_thread_background(true);
        })
        .exit_handler(|_| {
            crate::set_thread_background(false);
        })
        .build()
        .map_err(|error| format!("建立索引线程池失败：{error}"))
}

pub(super) fn install<T, F>(job: F) -> T
where
    T: Send,
    F: FnOnce() -> T + Send,
{
    match INDEX_POOL.get_or_init(build_pool) {
        Ok(pool) => pool.install(job),
        Err(error) => {
            crate::log(&format!("semantic_index_pool fallback=true error={error}"));
            job()
        }
    }
}

pub(super) fn builder_for(dimensions: usize, points: usize) -> instant_distance::Builder {
    // 高维向量的距离计算占据构图主要耗时。较窄的 construction breadth 保留
    // 100 的查询搜索宽度，同时减少大分片中最昂贵的候选比较。
    let construction = if dimensions >= 1536 && points >= 4_000 {
        64
    } else if dimensions >= 768 && points >= 8_000 {
        80
    } else {
        100
    };
    instant_distance::Builder::default()
        .ef_construction(construction)
        .ef_search(100)
        // Deterministic shards make crash-resume and checksum diagnostics
        // reproducible for identical input vectors.
        .seed(0x4B55_4E50_454E_4701)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedicated_pool_runs_jobs_and_nested_rayon_work() {
        use rayon::prelude::*;
        let sum = install(|| (0_u64..10_000).into_par_iter().sum::<u64>());
        assert_eq!(sum, 49_995_000);
    }

    #[test]
    fn builder_policy_only_reduces_large_high_dimensional_construction() {
        // Builder internals are intentionally private upstream, so verify the
        // policy through the public `into_parts` diagnostic API.
        let (_, high_dimensional_construction, _, _) = builder_for(1792, 10_000).into_parts();
        let (_, small_construction, _, _) = builder_for(384, 10_000).into_parts();
        assert_eq!(high_dimensional_construction, 64);
        assert_eq!(small_construction, 100);
    }
}
