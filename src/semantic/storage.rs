use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Write;

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect()
}

struct IntegrityWriter<W> {
    inner: W,
    hasher: Sha256,
    bytes: u64,
}

impl<W> IntegrityWriter<W> {
    fn new(inner: W) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
            bytes: 0,
        }
    }

    fn finish(self) -> (u64, String) {
        (
            self.bytes,
            self.hasher
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02X}"))
                .collect(),
        )
    }
}

impl<W: Write> Write for IntegrityWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(buffer)?;
        if written > 0 {
            self.hasher.update(&buffer[..written]);
            self.bytes = self.bytes.saturating_add(written as u64);
        }
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

pub(super) fn write_rmp_hashed<T: Serialize + ?Sized>(
    path: &std::path::Path,
    value: &T,
) -> Result<(u64, String), String> {
    crate::atomic_file::write_with(path, |file| {
        let buffered = std::io::BufWriter::new(file);
        let mut writer = IntegrityWriter::new(buffered);
        rmp_serde::encode::write(&mut writer, value)
            .map_err(|error| format!("序列化索引失败：{error}"))?;
        writer
            .flush()
            .map_err(|error| format!("刷新索引失败：{error}"))?;
        Ok(writer.finish())
    })
}
