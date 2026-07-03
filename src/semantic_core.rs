pub const SEM_VERSION: u32 = 2;
pub const SEM_MODEL: &str = "bge-small-zh-v1.5";
pub const SEM_QUERY_PREFIX: &str = "为这个句子生成表示以用于检索相关文章：";
pub const SHARD_MAX_CHUNKS: usize = 600_000;
pub const SEM_CACHE_BUDGET: usize = 1200 * 1024 * 1024;

#[cfg(windows)]
pub fn ram_total_avail() -> (u64, u64) {
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
    extern "system" {
        fn GlobalMemoryStatusEx(p: *mut MemStatusEx) -> i32;
    }
    let mut m: MemStatusEx = unsafe { std::mem::zeroed() };
    m.length = std::mem::size_of::<MemStatusEx>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut m) } != 0 {
        (m.total_phys, m.avail_phys)
    } else {
        (8 << 30, 4 << 30)
    }
}

#[cfg(not(windows))]
pub fn ram_total_avail() -> (u64, u64) {
    (8 << 30, 4 << 30)
}

pub fn index_ram_budget() -> u64 {
    let (total, avail) = ram_total_avail();
    (total / 2)
        .min(avail.saturating_sub(1 << 30) * 7 / 10)
        .max(512 << 20)
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
    fn shard_estimate_scales_with_chunks_and_dimensions() {
        assert_eq!(shard_est_bytes(2, 3), 824);
        assert!(index_ram_budget() >= 512 << 20);
    }
}
