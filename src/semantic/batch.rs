//! Adaptive embedding batch sizing.
//!
//! BGE Small 与 BGE Large 的内存需求不同。控制器从保守批量开始，连续成功
//! 后才增长；遇到内存压力时缩批重试同一段。

#[derive(Debug, Clone)]
pub(super) struct AdaptiveBatch {
    current: usize,
    minimum: usize,
    maximum: usize,
    successful_batches: u8,
}

impl AdaptiveBatch {
    pub(super) fn for_model(output_dimensions: usize) -> Self {
        let (minimum, current, maximum) = match output_dimensions {
            768.. => (1, 4, 16),
            _ => (2, 16, 32),
        };
        Self {
            current,
            minimum,
            maximum,
            successful_batches: 0,
        }
    }

    pub(super) fn current(&self) -> usize {
        self.current
    }

    /// Record a successful inference.  Growth is deliberately slow so a short
    /// book does not oscillate and a foreground reader window remains smooth.
    pub(super) fn record_success(&mut self) {
        self.successful_batches = self.successful_batches.saturating_add(1);
        if self.successful_batches >= 6 && self.current < self.maximum {
            self.current = (self.current.saturating_mul(2)).min(self.maximum);
            self.successful_batches = 0;
        }
    }

    /// Shrink after an allocation failure.  Returns `true` when retrying the
    /// same logical batch is useful; non-memory errors remain fatal.
    pub(super) fn shrink_for_error(&mut self, error: &str) -> bool {
        if !is_memory_pressure_error(error) || self.current <= self.minimum {
            return false;
        }
        self.current = (self.current / 2).max(self.minimum);
        self.successful_batches = 0;
        true
    }
}

pub(super) fn is_memory_pressure_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    [
        "out of memory",
        "failed to allocate",
        "memory allocation",
        "not enough memory",
        "bad allocation",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_bge_starts_conservatively_and_grows_after_stable_batches() {
        let mut batch = AdaptiveBatch::for_model(1024);
        assert_eq!(batch.current(), 4);
        for _ in 0..5 {
            batch.record_success();
        }
        assert_eq!(batch.current(), 4);
        batch.record_success();
        assert_eq!(batch.current(), 8);
    }

    #[test]
    fn memory_pressure_halves_and_can_retry_until_minimum() {
        let mut batch = AdaptiveBatch::for_model(1024);
        assert!(batch.shrink_for_error("out of memory"));
        assert_eq!(batch.current(), 2);
        assert!(batch.shrink_for_error("failed to allocate device memory"));
        assert_eq!(batch.current(), 1);
        assert!(!batch.shrink_for_error("out of memory"));
    }

    #[test]
    fn unrelated_inference_errors_are_not_retried() {
        let mut batch = AdaptiveBatch::for_model(512);
        assert!(!batch.shrink_for_error("invalid input tensor shape"));
        assert_eq!(batch.current(), 16);
    }

    #[test]
    fn recognises_common_allocator_messages_case_insensitively() {
        assert!(is_memory_pressure_error("Bad Allocation in arena"));
        assert!(is_memory_pressure_error("Not Enough Memory for tensor"));
        assert!(!is_memory_pressure_error("model file is missing"));
    }
}
