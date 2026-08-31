//! 逐书语义向量的磁盘格式、完整性校验与内存 LRU。
//!
//! 每本书由 `sem_<id>.json` 元数据和 `sem_<id>.vec` 连续小端 `f32`
//! 向量组成。此模块是该格式的唯一拥有者；搜索、画像和加速索引只通过只读
//! 访问器使用已经验证的数据。

use super::model;
use crate::semantic_core::{is_current_chunk_revision, SEM_CHUNK_PIPELINE_REVISION, SEM_VERSION};
use crate::{book, search, AppState};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::sync::{Mutex, OnceLock};

#[derive(Serialize, Deserialize)]
pub(super) struct Chunk {
    c: u32,
    t: String,
}

impl Chunk {
    pub(super) fn new(chapter: u32, text: String) -> Self {
        Self {
            c: chapter,
            t: text,
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Metadata {
    v: u32,
    model: String,
    mtime: u64,
    dim: usize,
    chunks: Vec<Chunk>,
    #[serde(default)]
    vector_bytes: u64,
    #[serde(default)]
    vector_sha256: String,
    #[serde(default)]
    source_id: String,
    #[serde(default)]
    source_bytes: u64,
    #[serde(default)]
    model_revision: String,
    #[serde(default)]
    chunk_revision: u32,
}

#[derive(Deserialize)]
struct StatusMetadataHeader {
    v: u32,
    model: String,
    mtime: u64,
    dim: usize,
}

#[derive(Default, Deserialize)]
struct StatusMetadataTail {
    #[serde(default)]
    vector_bytes: u64,
    #[serde(default)]
    vector_sha256: String,
    #[serde(default)]
    source_id: String,
    #[serde(default)]
    source_bytes: u64,
    #[serde(default)]
    model_revision: String,
    #[serde(default)]
    chunk_revision: u32,
}

struct StatusMetadata {
    header: StatusMetadataHeader,
    tail: StatusMetadataTail,
    chunks_empty: bool,
    metadata_bytes: u64,
}

/// 下游派生索引绑定的唯一来源签名。
///
/// 这不是一份“书目提示”，而是逐书向量通过版本、来源文件、尺寸与 SHA-256
/// 校验后才能生成的内容承诺。加速索引和多中心画像不得自行拼装或弱化它。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct IndexSourceSignature {
    pub(super) book_id: u64,
    pub(super) mtime: u64,
    pub(super) content_id: String,
    pub(super) source_bytes: u64,
    pub(super) vector_bytes: u64,
    pub(super) vector_sha256: String,
    pub(super) dim: usize,
    pub(super) chunks: usize,
    pub(super) model_id: String,
    pub(super) model_revision: String,
    pub(super) chunk_revision: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct VerifiedVectorKey {
    path: PathBuf,
    file_bytes: u64,
    file_modified_ns: u128,
    expected_sha256: String,
}

static VERIFIED_VECTOR_CACHE: OnceLock<Mutex<HashMap<u64, VerifiedVectorKey>>> = OnceLock::new();

fn verified_vector_cache() -> &'static Mutex<HashMap<u64, VerifiedVectorKey>> {
    VERIFIED_VECTOR_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 构建循环交给存储层发布的不可变结果。版本、模型与管线修订号由本模块写入，
/// 避免调用方直接拼装磁盘元数据。
pub(super) struct Publication {
    mtime: u64,
    source_id: String,
    source_bytes: u64,
    dim: usize,
    chunks: Vec<Chunk>,
    vector_bytes: u64,
    vector_sha256: String,
}

impl Publication {
    pub(super) fn empty(mtime: u64, source_id: &str, source_bytes: u64) -> Self {
        Self {
            mtime,
            source_id: source_id.into(),
            source_bytes,
            dim: 0,
            chunks: Vec::new(),
            vector_bytes: 0,
            vector_sha256: super::storage::sha256_hex(&[]),
        }
    }

    pub(super) fn populated(
        mtime: u64,
        source_id: &str,
        source_bytes: u64,
        dim: usize,
        chunks: Vec<Chunk>,
        vector_bytes: u64,
        vector_sha256: String,
    ) -> Self {
        Self {
            mtime,
            source_id: source_id.into(),
            source_bytes,
            dim,
            chunks,
            vector_bytes,
            vector_sha256,
        }
    }
}

/// 内存里的一本书向量数据：向量是连续、已 L2 归一化的 `[段落][维度]`。
pub(crate) struct SemData {
    dim: usize,
    vecs: Vec<f32>,
    chunks: Vec<Chunk>,
    _memory_permit: Option<crate::memory_budget::MemoryPermit>,
}

impl SemData {
    pub(super) fn dimensions(&self) -> usize {
        self.dim
    }

    pub(super) fn len(&self) -> usize {
        self.chunks.len()
    }

    pub(super) fn is_empty(&self) -> bool {
        self.chunks.is_empty() || self.dim == 0
    }

    pub(super) fn vector_parts(&self) -> (usize, usize, &[f32]) {
        (self.dim, self.chunks.len(), &self.vecs)
    }

    pub(super) fn vector(&self, index: usize) -> Option<&[f32]> {
        let start = index.checked_mul(self.dim)?;
        self.vecs.get(start..start.checked_add(self.dim)?)
    }

    pub(super) fn chunk(&self, index: usize) -> Option<(u32, &str)> {
        self.chunks
            .get(index)
            .map(|chunk| (chunk.c, chunk.t.as_str()))
    }

    pub(super) fn entries(&self) -> impl Iterator<Item = (u32, &str, &[f32])> {
        self.chunks
            .iter()
            .enumerate()
            .filter_map(move |(index, chunk)| {
                self.vector(index)
                    .map(|vector| (chunk.c, chunk.t.as_str(), vector))
            })
    }

    /// 从命中的短块向同章节两侧扩展，得到连续的“精读窗口”。基础索引仍以小块
    /// 保存；这里只在查询时临时拼接，避免为每本书持久化重复的大段正文。
    pub(super) fn context_around(
        &self,
        chapter: u32,
        snippet: &str,
        max_chars: usize,
    ) -> Option<String> {
        let center = self.chunks.iter().position(|chunk| {
            chunk.c == chapter
                && (chunk.t == snippet
                    || chunk.t.contains(snippet)
                    || snippet.contains(chunk.t.as_str()))
        })?;
        let mut selected = vec![center];
        let mut chars = self.chunks[center].t.chars().count();
        let mut left = center.checked_sub(1);
        let mut right = center + 1;
        // 左右交替扩展，使命中段落尽量处于上下文中间，而不是总落在窗口开头。
        while chars < max_chars && (left.is_some() || right < self.chunks.len()) {
            let mut advanced = false;
            if let Some(index) = left {
                let chunk = &self.chunks[index];
                if chunk.c == chapter {
                    let next = chunk.t.chars().count();
                    if chars + next <= max_chars {
                        selected.insert(0, index);
                        chars += next;
                    }
                    advanced = true;
                    left = index.checked_sub(1);
                } else {
                    left = None;
                }
            }
            if chars >= max_chars {
                break;
            }
            if right < self.chunks.len() {
                let chunk = &self.chunks[right];
                if chunk.c == chapter {
                    let next = chunk.t.chars().count();
                    if chars + next <= max_chars {
                        selected.push(right);
                        chars += next;
                    }
                    advanced = true;
                    right += 1;
                } else {
                    right = self.chunks.len();
                }
            }
            if !advanced {
                break;
            }
        }
        Some(
            selected
                .into_iter()
                .filter_map(|index| self.chunks.get(index).map(|chunk| chunk.t.as_str()))
                .collect::<Vec<_>>()
                .join("\n"),
        )
    }

    fn vector_bytes(&self) -> usize {
        self.vecs.len().saturating_mul(4)
    }
}

pub(super) fn directory() -> Option<std::path::PathBuf> {
    let mut directory = crate::profile::app_cache_dir()?;
    directory.push("sem");
    // 保留旧版 bge-small 的磁盘布局，其他模型各自使用独立目录。
    if model::active() != model::SemanticModel::BgeSmallZhV15 {
        directory.push(model::active_id());
    }
    Some(directory)
}

pub(super) fn metadata_path(id: u64) -> Option<std::path::PathBuf> {
    Some(directory()?.join(format!("sem_{id}.json")))
}

pub(super) fn vector_path(id: u64) -> Option<std::path::PathBuf> {
    Some(directory()?.join(format!("sem_{id}.vec")))
}

/// 未完成书籍只写入隐藏临时文件，容量统计与检索不会将其当作已建索引。
pub(super) fn build_temp_path(id: u64) -> Option<std::path::PathBuf> {
    Some(directory()?.join(format!(".sem_build_{id}.vec")))
}

fn read_metadata(id: u64) -> Option<Metadata> {
    serde_json::from_str(&std::fs::read_to_string(metadata_path(id)?).ok()?).ok()
}

const STATUS_METADATA_WINDOW_BYTES: usize = 8 * 1024;

fn find_bytes(buffer: &[u8], needle: &[u8]) -> Option<usize> {
    buffer
        .windows(needle.len())
        .position(|window| window == needle)
}

fn rfind_bytes(buffer: &[u8], needle: &[u8]) -> Option<usize> {
    buffer
        .windows(needle.len())
        .rposition(|window| window == needle)
}

fn parse_status_metadata_windows(
    head: &[u8],
    tail_window: &[u8],
    metadata_bytes: u64,
) -> Option<StatusMetadata> {
    const CHUNKS_MARKER: &[u8] = b",\"chunks\":";
    const TAIL_MARKER: &[u8] = b"],\"vector_bytes\":";

    let chunks_at = find_bytes(head, CHUNKS_MARKER)?;
    let mut header_json = head[..chunks_at].to_vec();
    header_json.push(b'}');
    let header: StatusMetadataHeader = serde_json::from_slice(&header_json).ok()?;

    let chunks_value = &head[chunks_at + CHUNKS_MARKER.len()..];
    let open_at = chunks_value
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())?;
    if chunks_value.get(open_at) != Some(&b'[') {
        return None;
    }
    let chunks_empty = chunks_value[open_at + 1..]
        .iter()
        .find(|byte| !byte.is_ascii_whitespace())
        == Some(&b']');

    let tail = if let Some(marker_at) = rfind_bytes(tail_window, TAIL_MARKER) {
        let mut tail_json = Vec::with_capacity(tail_window.len() - marker_at);
        tail_json.push(b'{');
        tail_json.extend_from_slice(&tail_window[marker_at + 2..]);
        serde_json::from_slice(&tail_json).ok()?
    } else {
        StatusMetadataTail::default()
    };
    Some(StatusMetadata {
        header,
        tail,
        chunks_empty,
        metadata_bytes,
    })
}

/// 管理窗口只需要元数据中的标量承诺，不需要载入 `chunks[].t` 正文。旧书库的
/// 逐书 JSON 可能达到几十 MB、全库合计数 GB；只读头尾各 8 KiB 可把状态核对
/// 从完整反序列化降为有界 I/O，同时仍要求当前管线修订和已发布向量尺寸匹配。
fn read_status_metadata(id: u64) -> Option<StatusMetadata> {
    let path = metadata_path(id)?;
    let mut file = std::fs::File::open(path).ok()?;
    let metadata_bytes = file.metadata().ok()?.len();
    let head_len = usize::try_from(metadata_bytes)
        .unwrap_or(usize::MAX)
        .min(STATUS_METADATA_WINDOW_BYTES);
    let mut head = vec![0_u8; head_len];
    file.read_exact(&mut head).ok()?;

    let tail_len = usize::try_from(metadata_bytes)
        .unwrap_or(usize::MAX)
        .min(STATUS_METADATA_WINDOW_BYTES);
    file.seek(SeekFrom::End(-(tail_len as i64))).ok()?;
    let mut tail_window = vec![0_u8; tail_len];
    file.read_exact(&mut tail_window).ok()?;
    parse_status_metadata_windows(&head, &tail_window, metadata_bytes)
}

fn status_metadata_is_fresh(metadata: &StatusMetadata, book: &book::Book) -> bool {
    if metadata.header.v != SEM_VERSION
        || metadata.header.model != model::active_id()
        || (!metadata.tail.model_revision.is_empty()
            && metadata.tail.model_revision != model::active().revision())
        || !is_current_chunk_revision(metadata.tail.chunk_revision)
    {
        return false;
    }
    let mtime = search::file_mtime(&book.path);
    if metadata.header.mtime == mtime {
        return true;
    }
    let bytes = source_bytes(book);
    if bytes == 0 || book.content_id.is_empty() {
        return false;
    }
    metadata.tail.source_id.is_empty()
        || (metadata.tail.source_id == book.content_id && metadata.tail.source_bytes == bytes)
}

fn status_vector_shape(metadata: &StatusMetadata, id: u64) -> Option<(u64, usize)> {
    if metadata.chunks_empty {
        return Some((0, 0));
    }
    let stride = (metadata.header.dim as u64).checked_mul(4)?;
    let expected = metadata.tail.vector_bytes;
    if stride == 0 || expected == 0 || !expected.is_multiple_of(stride) {
        return None;
    }
    let file_bytes = std::fs::metadata(vector_path(id)?).ok()?.len();
    if file_bytes != expected {
        return None;
    }
    Some((file_bytes, usize::try_from(expected / stride).ok()?))
}

/// 返回管理页的一次性快照：当前模型已完成本数、书架总数、有效索引实际字节数
/// 和可供派生索引核对的来源签名。每本书的巨大正文元数据只读取头尾小窗口。
pub(super) fn management_status_snapshot_fast(
    state: &AppState,
) -> (u32, u32, u64, Vec<IndexSourceSignature>) {
    let books = {
        let library = state.library.lock().unwrap_or_else(|poisoned| {
            crate::log("semantic_vector recovered poisoned library lock");
            poisoned.into_inner()
        });
        library
            .books
            .iter()
            .filter(|book| book.format != "pdf")
            .cloned()
            .collect::<Vec<_>>()
    };
    let total = books.len() as u32;
    let mut done = 0_u32;
    let mut bytes = 0_u64;
    let mut signatures = Vec::new();

    for book in &books {
        let Some(metadata) = read_status_metadata(book.id) else {
            continue;
        };
        if !status_metadata_is_fresh(&metadata, book) {
            continue;
        }
        let Some((vector_bytes, chunks)) = status_vector_shape(&metadata, book.id) else {
            continue;
        };
        done = done.saturating_add(1);
        bytes = bytes
            .saturating_add(metadata.metadata_bytes)
            .saturating_add(vector_bytes);

        if chunks == 0 || book.content_id.is_empty() {
            continue;
        }
        let strong = metadata.tail.model_revision == model::active().revision()
            && metadata.tail.chunk_revision == SEM_CHUNK_PIPELINE_REVISION
            && !metadata.tail.source_id.is_empty()
            && metadata.tail.source_id == book.content_id
            && metadata.tail.source_bytes == source_bytes(book)
            && integrity_sha256_is_valid(&metadata.tail.vector_sha256);
        let vector_sha256 = if strong {
            metadata.tail.vector_sha256.clone()
        } else {
            super::storage::sha256_hex(
                format!(
                    "legacy-sem-v2:{}:{}:{}:{}:{}",
                    book.content_id,
                    metadata.header.mtime,
                    vector_bytes,
                    metadata.header.dim,
                    chunks
                )
                .as_bytes(),
            )
        };
        signatures.push(IndexSourceSignature {
            book_id: book.id,
            mtime: metadata.header.mtime,
            content_id: if metadata.tail.source_id.is_empty() {
                book.content_id.clone()
            } else {
                metadata.tail.source_id.clone()
            },
            source_bytes: if metadata.tail.source_bytes == 0 {
                source_bytes(book)
            } else {
                metadata.tail.source_bytes
            },
            vector_bytes,
            vector_sha256,
            dim: metadata.header.dim,
            chunks,
            model_id: metadata.header.model,
            model_revision: if metadata.tail.model_revision.is_empty() {
                model::active().revision().into()
            } else {
                metadata.tail.model_revision
            },
            chunk_revision: metadata.tail.chunk_revision,
        });
    }
    signatures.sort_unstable_by_key(|signature| signature.book_id);
    (done, total, bytes, signatures)
}

pub(super) fn source_bytes(book: &book::Book) -> u64 {
    std::fs::metadata(&book.path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

fn metadata_is_fresh(metadata: &Metadata, book: &book::Book) -> bool {
    if metadata.v != SEM_VERSION
        || metadata.model != model::active_id()
        || (!metadata.model_revision.is_empty()
            && metadata.model_revision != model::active().revision())
        || !is_current_chunk_revision(metadata.chunk_revision)
    {
        return false;
    }
    let mtime = search::file_mtime(&book.path);
    source_is_current(metadata, book, mtime)
        && (metadata.source_id.is_empty()
            || (!book.content_id.is_empty() && metadata.source_id == book.content_id))
        && (metadata.source_bytes == 0 || metadata.source_bytes == source_bytes(book))
}

/// 文件同步、复制或解压可能改变 mtime，却不会改变导入时已记录的完整内容身份。
/// 对新格式索引，内容 SHA-256 与字节数同时匹配时比时间戳更可靠。早期索引没有
/// 把这两个字段写入自己的元数据，但书架已经保存并由启动期关键词维护复核完整
/// SHA-256；原书仍可访问时可将这份已验证的书架身份作为兼容依据，避免只因时间
/// 戳漂移而让完整向量反复要求重建。
fn source_is_current(metadata: &Metadata, book: &book::Book, mtime: u64) -> bool {
    if metadata.mtime == mtime {
        return true;
    }
    let bytes = source_bytes(book);
    if bytes == 0 || book.content_id.is_empty() {
        return false;
    }
    if metadata.source_id.is_empty() {
        // 兼容 v2 早期写入的元数据：身份由当前书架记录承担。
        return true;
    }
    metadata.source_id == book.content_id && metadata.source_bytes == bytes
}

fn integrity_sha256_is_valid(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// 派生索引只能接受当前严格格式；旧版可继续反序列化并供逐书兼容路径回填，
/// 但缺少任一来源/版本/完整性字段时绝不能被提升为全局索引来源。
fn metadata_is_strong_source(metadata: &Metadata, book: &book::Book) -> bool {
    metadata.v == SEM_VERSION
        && metadata.model == model::active_id()
        && metadata.model_revision == model::active().revision()
        && metadata.chunk_revision == SEM_CHUNK_PIPELINE_REVISION
        && source_is_current(metadata, book, search::file_mtime(&book.path))
        && !book.content_id.is_empty()
        && metadata.source_id == book.content_id
        && metadata.source_bytes == source_bytes(book)
        && metadata_has_vectors(metadata)
        && metadata.vector_bytes == expected_vector_bytes(metadata).unwrap_or(0)
        && integrity_sha256_is_valid(&metadata.vector_sha256)
}

/// 早期 v2 向量没有把来源 SHA、文件 SHA 和管线修订写回元数据；这类文件已经
/// 通过 `is_complete` 的结构检查，且其原书内容身份由书架维护。派生索引可以
/// 使用稳定的兼容签名重建，后续重新建立语义索引后会自然升级到严格签名。
fn metadata_is_compatible_source(metadata: &Metadata, book: &book::Book) -> bool {
    metadata_is_strong_source(metadata, book)
        || (metadata.v == SEM_VERSION
            && metadata.model == model::active_id()
            && metadata_is_fresh(metadata, book)
            && metadata_has_vectors(metadata)
            && !book.content_id.is_empty())
}

fn source_signature(metadata: &Metadata, book: &book::Book) -> IndexSourceSignature {
    let vector_bytes = expected_vector_bytes(metadata).unwrap_or(0);
    let legacy = metadata.vector_sha256.is_empty();
    IndexSourceSignature {
        book_id: book.id,
        mtime: metadata.mtime,
        content_id: if metadata.source_id.is_empty() {
            book.content_id.clone()
        } else {
            metadata.source_id.clone()
        },
        source_bytes: if metadata.source_bytes == 0 {
            source_bytes(book)
        } else {
            metadata.source_bytes
        },
        vector_bytes,
        // 旧文件没有真 SHA-256 时，绑定当前书架内容身份、向量形状和模型版本
        // 生成稳定兼容值。它不是文件哈希，实际载入仍进行向量尺寸校验。
        vector_sha256: if legacy {
            super::storage::sha256_hex(
                format!(
                    "legacy-sem-v2:{}:{}:{}:{}:{}",
                    book.content_id,
                    metadata.mtime,
                    vector_bytes,
                    metadata.dim,
                    metadata.chunks.len()
                )
                .as_bytes(),
            )
        } else {
            metadata.vector_sha256.clone()
        },
        dim: metadata.dim,
        chunks: metadata.chunks.len(),
        model_id: metadata.model.clone(),
        model_revision: if metadata.model_revision.is_empty() {
            model::active().revision().into()
        } else {
            metadata.model_revision.clone()
        },
        chunk_revision: metadata.chunk_revision,
    }
}

fn metadata_has_vectors(metadata: &Metadata) -> bool {
    metadata.dim > 0 && !metadata.chunks.is_empty()
}

fn expected_vector_bytes(metadata: &Metadata) -> Option<u64> {
    if !metadata_has_vectors(metadata) {
        return Some(0);
    }
    (metadata.dim as u64)
        .checked_mul(metadata.chunks.len() as u64)?
        .checked_mul(4)
}

fn vector_file_shape_valid(metadata: &Metadata, path: &std::path::Path) -> bool {
    let Some(expected) = expected_vector_bytes(metadata) else {
        return false;
    };
    if metadata.vector_bytes != 0 && metadata.vector_bytes != expected {
        return false;
    }
    std::fs::metadata(path)
        .map(|file| file.len() == expected)
        .unwrap_or(false)
}

fn file_modified_ns(metadata: &std::fs::Metadata) -> Option<u128> {
    metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_nanos())
}

fn hash_file(path: &Path) -> Option<String> {
    let mut reader = std::io::BufReader::new(std::fs::File::open(path).ok()?);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 256 * 1024];
    loop {
        let read = reader.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Some(
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect(),
    )
}

/// 首次使用实际流式计算 SHA-256；后续仅在操作系统文件身份（路径、长度、
/// 纳秒修改时间）或元数据承诺变化时重算。正常索引发布/删除会主动清缓存。
fn vector_file_integrity_valid(id: u64, metadata: &Metadata, path: &Path) -> bool {
    let Ok(file_metadata) = std::fs::metadata(path) else {
        return false;
    };
    let Some(modified_ns) = file_modified_ns(&file_metadata) else {
        return false;
    };
    let key = VerifiedVectorKey {
        path: path.to_path_buf(),
        file_bytes: file_metadata.len(),
        file_modified_ns: modified_ns,
        expected_sha256: metadata.vector_sha256.clone(),
    };
    if verified_vector_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(&id).cloned())
        .as_ref()
        == Some(&key)
    {
        return true;
    }
    if key.file_bytes != metadata.vector_bytes
        || hash_file(path).as_deref() != Some(metadata.vector_sha256.as_str())
    {
        if let Ok(mut cache) = verified_vector_cache().lock() {
            cache.remove(&id);
        }
        return false;
    }
    if let Ok(mut cache) = verified_vector_cache().lock() {
        cache.insert(id, key);
    }
    true
}

/// 从当前 Library 图书和逐书向量生成来源签名。新版必须完整校验；历史 v2
/// 索引则走受限兼容签名，令画像/加速索引能在不重嵌入全部书籍的情况下升级。
pub(super) fn index_source_signature(book: &book::Book) -> Option<IndexSourceSignature> {
    let metadata = read_metadata(book.id)?;
    if !metadata_is_compatible_source(&metadata, book) {
        return None;
    }
    let path = vector_path(book.id)?;
    if !vector_file_shape_valid(&metadata, &path)
        || (!metadata.vector_sha256.is_empty()
            && !vector_file_integrity_valid(book.id, &metadata, &path))
    {
        return None;
    }
    Some(source_signature(&metadata, book))
}

/// 查询候选阶段只比较已发布元数据，不流式重哈希可能达到数十 GB 的向量文件。
/// 真正载入候选书向量时 `load` 仍会做尺寸与 SHA-256 完整校验。
pub(super) fn index_source_signature_fast(book: &book::Book) -> Option<IndexSourceSignature> {
    let metadata = read_metadata(book.id)?;
    if !metadata_is_compatible_source(&metadata, book) {
        return None;
    }
    let path = vector_path(book.id)?;
    if !vector_file_shape_valid(&metadata, &path) {
        return None;
    }
    Some(source_signature(&metadata, book))
}

pub(super) fn index_source_snapshot(state: &AppState) -> Vec<IndexSourceSignature> {
    let books = {
        let library = state.library.lock().unwrap_or_else(|poisoned| {
            crate::log("semantic_vector recovered poisoned library lock");
            poisoned.into_inner()
        });
        library
            .books
            .iter()
            .filter(|book| book.format != "pdf")
            .cloned()
            .collect::<Vec<_>>()
    };
    // 完整性校验可能顺序读取数 GB 向量。绝不能在这段磁盘 I/O 期间持有书架锁，
    // 否则后台状态刷新也会阻塞封面、筛选和窗口交互。
    let mut snapshot: Vec<_> = books.iter().filter_map(index_source_signature).collect();
    snapshot.sort_unstable_by_key(|signature| signature.book_id);
    snapshot
}

fn decode_vector_bytes(metadata: &Metadata, bytes: &[u8]) -> Option<Vec<f32>> {
    let expected = expected_vector_bytes(metadata)?;
    if bytes.len() as u64 != expected
        || (metadata.vector_bytes != 0 && metadata.vector_bytes != expected)
        || (!metadata.vector_sha256.is_empty()
            && super::storage::sha256_hex(bytes) != metadata.vector_sha256)
    {
        return None;
    }
    Some(
        bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|&bytes| f32::from_le_bytes(bytes))
            .collect(),
    )
}

pub(super) fn publish_metadata(id: u64, publication: Publication) -> Result<(), String> {
    let metadata = Metadata {
        v: SEM_VERSION,
        model: model::active_id().into(),
        mtime: publication.mtime,
        dim: publication.dim,
        chunks: publication.chunks,
        vector_bytes: publication.vector_bytes,
        vector_sha256: publication.vector_sha256,
        source_id: publication.source_id,
        source_bytes: publication.source_bytes,
        model_revision: model::active().revision().into(),
        chunk_revision: SEM_CHUNK_PIPELINE_REVISION,
    };
    crate::atomic_file::write_json(&metadata_path(id).ok_or("无缓存路径")?, &metadata, false)?;
    if let Ok(mut cache) = verified_vector_cache().lock() {
        cache.remove(&id);
    }
    Ok(())
}

pub(super) fn is_complete(book: &book::Book) -> bool {
    let Some(metadata) = read_metadata(book.id) else {
        return false;
    };
    if !metadata_is_fresh(&metadata, book) {
        return false;
    }
    if !metadata_has_vectors(&metadata) {
        return true;
    }
    // 单中心画像只是相似图书候选筛选的派生缓存，不属于逐书语义向量本体。
    // 画像缺失或过期时可由现有向量快速回填，不能因此把完整语义索引记成
    // “未完成”，更不能触发整本书重新嵌入。
    vector_path(book.id)
        .map(|path| vector_file_shape_valid(&metadata, &path))
        .unwrap_or(false)
}

/// 加速索引只需要已发布元数据中的维度和段落数，不接触磁盘格式字段。
pub(super) fn stored_shape(id: u64) -> Option<(usize, usize)> {
    let metadata = read_metadata(id)?;
    if metadata.v != SEM_VERSION
        || metadata.model != model::active_id()
        || !metadata_has_vectors(&metadata)
    {
        return None;
    }
    Some((metadata.dim, metadata.chunks.len()))
}

/// 逐段读取超大书的向量。加速索引不能把一整本数 GB 的 `.vec` 同时放进内存；
/// 此接口只读取请求范围的连续 float，并在回调返回前保持文本与向量切片有效。
/// 调用方必须已通过来源签名和文件形状校验，因而这里不重复顺序读取整文件哈希。
pub(super) fn visit_entries_range(
    id: u64,
    start: usize,
    count: usize,
    mut visit: impl FnMut(u32, &str, &[f32]),
) -> Option<(usize, usize)> {
    let metadata = read_metadata(id)?;
    if !metadata_has_vectors(&metadata) || start >= metadata.chunks.len() || count == 0 {
        return Some((metadata.dim, 0));
    }
    let path = vector_path(id)?;
    if !vector_file_shape_valid(&metadata, &path) {
        return None;
    }
    let available = metadata.chunks.len().saturating_sub(start);
    let count = count.min(available);
    let float_offset = start.checked_mul(metadata.dim)?;
    let float_count = count.checked_mul(metadata.dim)?;
    let byte_offset = u64::try_from(float_offset.checked_mul(4)?).ok()?;
    let byte_count = float_count.checked_mul(4)?;
    let mut file = std::fs::File::open(path).ok()?;
    file.seek(SeekFrom::Start(byte_offset)).ok()?;
    let mut bytes = vec![0_u8; byte_count];
    file.read_exact(&mut bytes).ok()?;
    for (index, chunk) in metadata.chunks[start..start + count].iter().enumerate() {
        let offset = index.checked_mul(metadata.dim)?;
        let vector =
            bytes.get(offset.checked_mul(4)?..offset.checked_add(metadata.dim)?.checked_mul(4)?)?;
        // vec 的写入格式固定为小端 f32；避免为整个超大书建立 Vec<f32> 副本。
        let mut values = Vec::with_capacity(metadata.dim);
        values.extend(
            vector
                .as_chunks::<4>()
                .0
                .iter()
                .map(|&bytes| f32::from_le_bytes(bytes)),
        );
        visit(chunk.c, &chunk.t, &values);
    }
    Some((metadata.dim, count))
}

pub(super) fn metadata_exists(id: u64) -> bool {
    metadata_path(id).is_some_and(|path| path.exists())
}

/// 取一本书的向量数据：命中 LRU 时只更新顺序，否则校验元数据、尺寸和哈希后载入。
pub(super) fn load(state: &AppState, id: u64) -> Option<Arc<SemData>> {
    let cached = {
        let cache = state.sem_cache.lock().unwrap_or_else(|poisoned| {
            crate::log("semantic_vector recovered poisoned cache lock");
            poisoned.into_inner()
        });
        cache.get(&id).cloned()
    };
    if let Some(data) = cached {
        if let Ok(mut order) = state.sem_cache_order.lock() {
            order.retain(|cached_id| *cached_id != id);
            order.push_back(id);
        }
        return Some(data);
    }

    let metadata = read_metadata(id)?;
    let path = vector_path(id)?;
    if !vector_file_shape_valid(&metadata, &path) {
        crate::log(&format!("semantic_vector_invalid id={id}"));
        return None;
    }
    let vector_bytes = expected_vector_bytes(&metadata)?;
    let text_bytes = metadata
        .chunks
        .iter()
        .fold(0_u64, |sum, chunk| sum.saturating_add(chunk.t.len() as u64));
    let resident_bytes = vector_bytes.saturating_add(text_bytes).saturating_add(
        (metadata.chunks.len() as u64).saturating_mul(std::mem::size_of::<Chunk>() as u64),
    );
    let governor = crate::memory_budget::governor();
    let resident_permit = governor
        .try_acquire(
            crate::memory_budget::MemoryClass::SemanticVector,
            crate::memory_budget::MemoryUsageKind::Resident,
            resident_bytes,
        )
        .map_err(|error| {
            crate::log(&format!(
                "semantic_vector_load denied id={id} bytes={resident_bytes} error={error}"
            ));
        })
        .ok()?;
    let transient_permit = governor
        .try_acquire(
            crate::memory_budget::MemoryClass::SemanticVector,
            crate::memory_budget::MemoryUsageKind::Transient,
            vector_bytes,
        )
        .map_err(|error| {
            crate::log(&format!(
                "semantic_vector_read denied id={id} bytes={vector_bytes} error={error}"
            ));
        })
        .ok()?;
    let bytes = std::fs::read(path).ok()?;
    let Some(vecs) = decode_vector_bytes(&metadata, &bytes) else {
        crate::log(&format!("semantic_vector_hash_invalid id={id}"));
        return None;
    };
    let data = Arc::new(SemData {
        dim: metadata.dim,
        vecs,
        chunks: metadata.chunks,
        _memory_permit: Some(resident_permit),
    });
    drop(transient_permit);

    let size = data.vector_bytes();
    let budget = crate::memory_budget::plan().semantic_vector_bytes as usize;
    if size <= budget {
        let mut cache = state.sem_cache.lock().unwrap_or_else(|poisoned| {
            crate::log("semantic_vector recovered poisoned cache lock");
            poisoned.into_inner()
        });
        let mut order = state.sem_cache_order.lock().unwrap_or_else(|poisoned| {
            crate::log("semantic_vector recovered poisoned cache-order lock");
            poisoned.into_inner()
        });
        if let Some(existing) = cache.get(&id) {
            return Some(existing.clone());
        }
        let mut used = state.sem_cache_bytes.load(Ordering::Relaxed);
        while used.saturating_add(size) > budget {
            let Some(old_id) = order.pop_front() else {
                break;
            };
            if let Some(old) = cache.remove(&old_id) {
                used = used.saturating_sub(old.vector_bytes());
            }
        }
        if used.saturating_add(size) <= budget {
            cache.insert(id, data.clone());
            order.retain(|cached_id| *cached_id != id);
            order.push_back(id);
            state
                .sem_cache_bytes
                .store(used.saturating_add(size), Ordering::Relaxed);
        }
    }
    Some(data)
}

pub(super) fn evict_cached(state: &AppState, id: u64) {
    if let Ok(mut cache) = state.sem_cache.lock() {
        if let Some(old) = cache.remove(&id) {
            state
                .sem_cache_bytes
                .fetch_sub(old.vector_bytes(), Ordering::Relaxed);
        }
    }
    if let Ok(mut order) = state.sem_cache_order.lock() {
        order.retain(|cached_id| *cached_id != id);
    }
}

pub(super) fn clear_memory_cache(state: &AppState) {
    if let Ok(mut cache) = state.sem_cache.lock() {
        cache.clear();
    }
    if let Ok(mut order) = state.sem_cache_order.lock() {
        order.clear();
    }
    state.sem_cache_bytes.store(0, Ordering::Relaxed);
}

/// 删除逐书索引文件。画像模块随后负责清理它自己的文件与缓存。
pub(super) fn delete_index_files() {
    let Some(directory) = directory() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("sem_") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    if let Ok(mut cache) = verified_vector_cache().lock() {
        cache.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata(chunks: usize, hash: String) -> Metadata {
        Metadata {
            v: SEM_VERSION,
            model: model::active_id().into(),
            mtime: 1,
            dim: 2,
            chunks: (0..chunks)
                .map(|chapter| Chunk::new(chapter as u32, String::new()))
                .collect(),
            vector_bytes: (chunks * 2 * 4) as u64,
            vector_sha256: hash,
            source_id: String::new(),
            source_bytes: 0,
            model_revision: String::new(),
            chunk_revision: 0,
        }
    }

    #[test]
    fn vector_shape_rejects_a_truncated_file() {
        let directory = std::env::temp_dir().join(format!(
            "kunpeng-sem-shape-{}-{}",
            std::process::id(),
            crate::now_ms()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("book.vec");
        let metadata = metadata(2, String::new());
        std::fs::write(&path, [0_u8; 12]).unwrap();
        assert!(!vector_file_shape_valid(&metadata, &path));
        std::fs::write(&path, [0_u8; 16]).unwrap();
        assert!(vector_file_shape_valid(&metadata, &path));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn vector_hash_rejects_a_same_length_bit_flip() {
        let bytes = [0_u8; 16];
        let metadata = metadata(2, super::super::storage::sha256_hex(&bytes));
        assert!(decode_vector_bytes(&metadata, &bytes).is_some());
        let mut changed = bytes;
        changed[7] ^= 0x01;
        assert!(decode_vector_bytes(&metadata, &changed).is_none());
    }

    #[test]
    fn legacy_optional_integrity_fields_still_deserialize() {
        let json = format!(
            r#"{{"v":{SEM_VERSION},"model":"{}","mtime":1,"dim":0,"chunks":[]}}"#,
            model::active_id()
        );
        let metadata: Metadata = serde_json::from_str(&json).unwrap();
        assert_eq!(metadata.vector_bytes, 0);
        assert!(metadata.vector_sha256.is_empty());
        assert!(metadata.source_id.is_empty());
        assert_eq!(metadata.chunk_revision, 0);
    }

    #[test]
    fn context_window_is_continuous_and_never_crosses_a_chapter() {
        let data = SemData {
            dim: 1,
            vecs: vec![1.0, 1.0, 1.0, 1.0],
            chunks: vec![
                Chunk::new(2, "前文论证。".into()),
                Chunk::new(2, "核心结论及其限定。".into()),
                Chunk::new(2, "后续例外。".into()),
                Chunk::new(3, "下一章不能混入。".into()),
            ],
            _memory_permit: None,
        };

        let context = data.context_around(2, "核心结论", 64).unwrap();
        assert!(context.contains("前文论证"));
        assert!(context.contains("核心结论及其限定"));
        assert!(context.contains("后续例外"));
        assert!(!context.contains("下一章不能混入"));
    }

    #[test]
    fn status_metadata_reads_only_scalar_head_and_tail_windows() {
        let head = format!(
            r#"{{"v":{SEM_VERSION},"model":"{}","mtime":123,"dim":512,"chunks":[{{"c":0,"t":"正文不应被反序列化"}}"#,
            model::active_id()
        );
        let tail = format!(
            r#""}}],"vector_bytes":2048,"vector_sha256":"{}","source_id":"book-sha","source_bytes":99,"model_revision":"{}","chunk_revision":{SEM_CHUNK_PIPELINE_REVISION}}}"#,
            "A".repeat(64),
            model::active().revision()
        );
        let status = parse_status_metadata_windows(head.as_bytes(), tail.as_bytes(), 65_000_000)
            .expect("bounded metadata windows must parse");
        assert_eq!(status.header.model, model::active_id());
        assert_eq!(status.header.dim, 512);
        assert!(!status.chunks_empty);
        assert_eq!(status.tail.vector_bytes, 2048);
        assert_eq!(status.tail.chunk_revision, SEM_CHUNK_PIPELINE_REVISION);
        assert_eq!(status.metadata_bytes, 65_000_000);

        let source = include_str!("vector.rs");
        let start = source
            .find("fn read_status_metadata")
            .expect("bounded reader must exist");
        let end = start
            + source[start..]
                .find("fn status_metadata_is_fresh")
                .expect("freshness check must follow bounded reader");
        let implementation = &source[start..end];
        assert!(implementation.contains("STATUS_METADATA_WINDOW_BYTES"));
        assert!(!implementation.contains("read_to_string"));
    }

    #[test]
    fn vector_completion_does_not_depend_on_auxiliary_profiles() {
        let source = include_str!("vector.rs");
        let start = source
            .find("pub(super) fn is_complete")
            .expect("completion predicate must exist");
        let end = start
            + source[start..]
                .find("pub(super) fn stored_shape")
                .expect("completion predicate must stay bounded");
        let completion = &source[start..end];
        assert!(completion.contains("metadata_is_fresh"));
        assert!(completion.contains("vector_file_shape_valid"));
        assert!(
            !completion.contains("profile::"),
            "auxiliary profiles must not reduce the semantic vector completion count"
        );
    }

    #[test]
    fn strong_snapshot_releases_the_library_before_disk_integrity_checks() {
        let source = include_str!("vector.rs");
        let start = source
            .find("pub(super) fn index_source_snapshot")
            .expect("snapshot must exist");
        let end = start
            + source[start..]
                .find("fn decode_vector_bytes")
                .expect("vector decoder must follow the strong snapshot");
        let implementation = &source[start..end];
        let clone_finished = implementation
            .find("collect::<Vec<_>>()")
            .expect("books must be cloned out of the library lock");
        let integrity_scan = implementation
            .find("filter_map(index_source_signature)")
            .expect("strong snapshot must still validate vector integrity");
        assert!(clone_finished < integrity_scan);
    }

    #[test]
    fn vector_implementation_stays_out_of_the_parent_module() {
        let parent = include_str!("../semantic.rs");
        for forbidden in [
            "struct SemChunk",
            "struct SemMeta",
            "pub(crate) struct SemData",
            "fn read_sem_meta",
            "fn sem_meta_is_fresh",
            "fn sem_vector_file_shape_valid",
        ] {
            assert!(
                !parent.contains(forbidden),
                "vector boundary regressed: {forbidden}"
            );
        }
        assert!(parent.contains("pub(crate) use vector::SemData"));
        assert!(parent.contains("vector::load(state, id)"));
    }
}
