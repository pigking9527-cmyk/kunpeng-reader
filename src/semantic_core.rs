pub const SEM_VERSION: u32 = 2;
pub const SEM_CHUNK_PIPELINE_REVISION: u32 = 1;
pub const SHARD_MAX_CHUNKS: usize = 600_000;

pub fn index_ram_budget() -> u64 {
    crate::memory_budget::plan().semantic_graph_bytes
}

pub fn shard_est_bytes(chunks: usize, dim: usize) -> u64 {
    chunks as u64 * (dim as u64 * 4 + 400)
}

pub fn normalize(v: &mut [f32]) {
    let mut n = 0.0f32;
    for x in v.iter() {
        n += x * x;
    }
    let n = n.sqrt();
    if n > 0.0 {
        for x in v.iter_mut() {
            *x /= n;
        }
    }
}

pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    let mut s = 0.0f32;
    for i in 0..a.len().min(b.len()) {
        s += a[i] * b[i];
    }
    s
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let mut aa = 0.0;
    let mut bb = 0.0;
    let mut ab = 0.0;
    for i in 0..a.len().min(b.len()) {
        aa += a[i] * a[i];
        bb += b[i] * b[i];
        ab += a[i] * b[i];
    }
    if aa == 0.0 || bb == 0.0 {
        0.0
    } else {
        ab / (aa.sqrt() * bb.sqrt())
    }
}

pub fn chunk_text(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut cur = String::new();
    let mut count = 0usize;
    for ch in text.chars() {
        cur.push(ch);
        count += 1;
        let is_end = matches!(ch, '。' | '！' | '？' | '!' | '?' | '\n' | '…' | '.');
        if (is_end && count >= 200) || count >= 400 {
            let t = cur.trim();
            if t.chars().count() >= 8 {
                chunks.push(t.to_string());
            }
            cur.clear();
            count = 0;
        }
    }
    let t = cur.trim();
    if t.chars().count() >= 8 {
        chunks.push(t.to_string());
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_keeps_zero_and_normalizes_nonzero_vector() {
        let mut zero = [0.0, 0.0];
        normalize(&mut zero);
        assert_eq!(zero, [0.0, 0.0]);

        let mut v = [3.0, 4.0];
        normalize(&mut v);
        assert!((v[0] - 0.6).abs() < 0.0001);
        assert!((v[1] - 0.8).abs() < 0.0001);
    }

    #[test]
    fn dot_and_cosine_use_common_prefix_dimensions() {
        assert_eq!(dot(&[1.0, 2.0, 3.0], &[4.0, 5.0]), 14.0);
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 0.0001);
        assert_eq!(cosine(&[0.0, 0.0], &[1.0, 2.0]), 0.0);
    }

    #[test]
    fn chunk_text_drops_tiny_fragments_and_splits_long_text() {
        assert!(chunk_text("短句。").is_empty());
        let long = "这是一段足够长的句子，用来测试语义切块不会丢失有效内容。".repeat(10);
        let chunks = chunk_text(&long);
        assert!(!chunks.is_empty());
        assert!(chunks.iter().all(|c| c.chars().count() >= 8));
    }

    #[test]
    fn chunk_text_uses_newlines_as_boundaries_when_segment_is_long_enough() {
        let a = "第一段内容足够长，用来确认换行可以形成独立语义片段。".repeat(5);
        let b = "第二段内容也足够长，用来确认后续内容不会被前一段吞掉。".repeat(5);
        let chunks = chunk_text(&format!("{a}\n{b}"));
        assert!(chunks.len() >= 2);
        assert!(chunks.first().unwrap().contains("第一段内容"));
        assert!(chunks.last().unwrap().contains("第二段内容"));
    }

    #[test]
    fn shard_estimate_scales_with_chunks_and_dimensions() {
        assert_eq!(shard_est_bytes(2, 3), 824);
        assert_eq!(
            index_ram_budget(),
            crate::memory_budget::plan().semantic_graph_bytes
        );
    }
}
