use crate::{reader_window_id, search};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// 每本书的"页数缓存"：版式签名 + 各章页数。版式（窗口尺寸/字体/边距…）一致就直接复用，免重算。
#[derive(Serialize, Deserialize)]
pub(crate) struct PageCacheData {
    pub(crate) sig: String,
    pub(crate) pages: Vec<u32>,
}

fn pages_dir() -> Option<std::path::PathBuf> {
    let mut d = dirs::cache_dir()?;
    d.push("ebook-reader");
    d.push("pages");
    Some(d)
}

fn page_cache_path(id: u64) -> Option<std::path::PathBuf> {
    Some(pages_dir()?.join(format!("{id}.json")))
}

/// 读取这本书已缓存的页数（阅读窗口就绪后取，交给合并页判断版式是否一致）。
#[tauri::command]
pub(crate) fn get_page_cache(window: tauri::WebviewWindow) -> Option<PageCacheData> {
    let id = reader_window_id(&window)?;
    let s = std::fs::read_to_string(page_cache_path(id)?).ok()?;
    serde_json::from_str(&s).ok()
}

/// 合并页测完整书页数后落盘缓存。
#[tauri::command]
pub(crate) fn save_page_cache(
    window: tauri::WebviewWindow,
    sig: String,
    pages: Vec<u32>,
) -> Result<(), ()> {
    if let Some(id) = reader_window_id(&window) {
        if let Some(p) = page_cache_path(id) {
            if let Some(d) = p.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            if let Ok(j) = serde_json::to_string(&PageCacheData { sig, pages }) {
                let _ = std::fs::write(p, j);
            }
        }
    }
    Ok(())
}

/// 每本 PDF 的视图状态：缩放倍数 + 是否双页。让 PDF 记住自己上次的缩放。
#[derive(Serialize, Deserialize)]
pub(crate) struct PdfState {
    pub(crate) scale: f32,
    pub(crate) dual: bool,
}

fn pdf_state_path(id: u64) -> Option<std::path::PathBuf> {
    let mut d = dirs::cache_dir()?;
    d.push("ebook-reader");
    d.push("pdfstate");
    Some(d.join(format!("{id}.json")))
}

/// 读取这本 PDF 上次的缩放/双页状态（打开时取，用来恢复视图）。
#[tauri::command]
pub(crate) fn get_pdf_state(window: tauri::WebviewWindow) -> Option<PdfState> {
    let id = reader_window_id(&window)?;
    let s = std::fs::read_to_string(pdf_state_path(id)?).ok()?;
    serde_json::from_str(&s).ok()
}

/// 保存这本 PDF 的缩放/双页状态（缩放或切换双页时调用）。
#[tauri::command]
pub(crate) fn set_pdf_state(
    window: tauri::WebviewWindow,
    scale: f32,
    dual: bool,
) -> Result<(), ()> {
    if let Some(id) = reader_window_id(&window) {
        if let Some(p) = pdf_state_path(id) {
            if let Some(d) = p.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            if let Ok(j) = serde_json::to_string(&PdfState { scale, dual }) {
                let _ = std::fs::write(p, j);
            }
        }
    }
    Ok(())
}

/// PDF 字数：抽取每页文本，统计非空白字符数。
pub(crate) fn pdf_word_count(path: &Path) -> u64 {
    search::extract_pdf_pages(path)
        .iter()
        .map(|s| s.chars().filter(|c| !c.is_whitespace()).count() as u64)
        .sum()
}

/// 从 PDF 的 Info 字典读 /Author（支持 UTF-16BE BOM 与普通编码）。读不到返回空串。
pub(crate) fn pdf_author(path: &Path) -> String {
    let Ok(doc) = lopdf::Document::load(path) else {
        return String::new();
    };
    let Ok(info_obj) = doc.trailer.get(b"Info") else {
        return String::new();
    };
    let dict = match info_obj.as_reference().and_then(|r| doc.get_dictionary(r)) {
        Ok(d) => d,
        Err(_) => match info_obj.as_dict() {
            Ok(d) => d,
            Err(_) => return String::new(),
        },
    };
    match dict.get(b"Author") {
        Ok(lopdf::Object::String(bytes, _)) => decode_pdf_string(bytes),
        _ => String::new(),
    }
}

/// 解码 PDF 文本串：FE FF 开头→UTF-16BE；否则按 Latin-1/UTF-8 兜底。
fn decode_pdf_string(b: &[u8]) -> String {
    if b.len() >= 2 && b[0] == 0xFE && b[1] == 0xFF {
        let u16s: Vec<u16> = b[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&u16s).trim().to_string()
    } else if let Ok(s) = std::str::from_utf8(b) {
        s.trim().to_string()
    } else {
        b.iter()
            .map(|&c| c as char)
            .collect::<String>()
            .trim()
            .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_pdf_utf16be_string() {
        let raw = [0xFE, 0xFF, 0x4F, 0x60, 0x59, 0x7D];
        assert_eq!(decode_pdf_string(&raw), "你好");
    }

    #[test]
    fn decode_pdf_utf8_string_and_trim() {
        assert_eq!(decode_pdf_string(" Alice ".as_bytes()), "Alice");
    }

    #[test]
    fn decode_pdf_latin1_fallback() {
        assert_eq!(decode_pdf_string(&[0xC9, b'm', b'i', b'l', b'e']), "Émile");
    }
}
