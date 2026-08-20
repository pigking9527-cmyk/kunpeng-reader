//! Pure capacity and persistence-throttle policy for background tasks.
//!
//! Thread creation, queues, locks, atomics, clocks and durable writes remain in
//! the parent module; this module only makes their deterministic decisions.

/// Leave one logical CPU for the foreground while bounding the shared pool to
/// two workers. A single-core system still receives one background worker.
pub(super) fn shared_worker_count(available_parallelism: usize) -> usize {
    available_parallelism.saturating_sub(1).clamp(1, 2)
}

/// Forced writes are always due. Best-effort writes use a monotonic elapsed
/// clock and saturating subtraction so an unexpected clock reset cannot wrap.
pub(super) fn persistence_write_due(
    force: bool,
    now_elapsed_ms: u64,
    previous_elapsed_ms: u64,
    throttle_ms: u64,
) -> bool {
    force || now_elapsed_ms.saturating_sub(previous_elapsed_ms) >= throttle_ms
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_count_leaves_foreground_capacity_and_never_exceeds_two() {
        let cases = [(0, 1), (1, 1), (2, 1), (3, 2), (64, 2)];
        for (available, expected) in cases {
            assert_eq!(shared_worker_count(available), expected);
        }
    }

    #[test]
    fn persistence_throttle_uses_elapsed_time_and_force_bypasses_it() {
        assert!(!persistence_write_due(false, 999, 0, 1_000));
        assert!(persistence_write_due(false, 1_000, 0, 1_000));
        assert!(!persistence_write_due(false, 50, 100, 1_000));
        assert!(persistence_write_due(true, 0, u64::MAX, 1_000));
        assert!(persistence_write_due(false, 0, 0, 0));
    }
}
