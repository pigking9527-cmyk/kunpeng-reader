//! Optional open-source reading fonts.
//!
//! Fonts are downloaded on demand rather than bundled in every installer.  The
//! catalog is deliberately fixed: only the reviewed upstream files and hashes
//! below can be written into the font cache or served by the reader protocol.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Clone, Copy)]
struct FontSpec {
    slot: u64,
    id: &'static str,
    label: &'static str,
    family: &'static str,
    file_name: &'static str,
    url: &'static str,
    download_bytes: u64,
    download_sha256: &'static str,
    installed_bytes: u64,
    installed_sha256: &'static str,
    zip_entry: Option<&'static str>,
}

const FONTS: &[FontSpec] = &[
    FontSpec {
        slot: 1,
        id: "lxgw-wenkai-lite",
        label: "霞鹜文楷 Lite",
        family: "Kunpeng LXGW WenKai Lite",
        file_name: "LXGWWenKaiLite-Regular.ttf",
        url: "https://github.com/lxgw/LxgwWenKai-Lite/releases/download/v1.522/LXGWWenKaiLite-Regular.ttf",
        download_bytes: 13_872_424,
        download_sha256: "140C99BA4E28E817CEC49BF82A0C5FCDC4FE633FB9DFDA16D0EE8D59A8545F15",
        installed_bytes: 13_872_424,
        installed_sha256: "140C99BA4E28E817CEC49BF82A0C5FCDC4FE633FB9DFDA16D0EE8D59A8545F15",
        zip_entry: None,
    },
    FontSpec {
        slot: 2,
        id: "source-han-serif-sc",
        label: "思源宋体",
        family: "Kunpeng Source Han Serif SC",
        file_name: "SourceHanSerifSC-Regular.otf",
        url: "https://raw.githubusercontent.com/adobe-fonts/source-han-serif/2.003R/OTF/SimplifiedChinese/SourceHanSerifSC-Regular.otf",
        download_bytes: 24_543_332,
        download_sha256: "78AA7A328FD974DF2D688C8A9FD74A33D8334DFA84AB24D9D11EFB2FFC464117",
        installed_bytes: 24_543_332,
        installed_sha256: "78AA7A328FD974DF2D688C8A9FD74A33D8334DFA84AB24D9D11EFB2FFC464117",
        zip_entry: None,
    },
    FontSpec {
        slot: 3,
        id: "zhuque-fangsong",
        label: "朱雀仿宋",
        family: "Kunpeng Zhuque Fangsong",
        file_name: "ZhuqueFangsong-Regular.ttf",
        url: "https://github.com/TrionesType/zhuque/releases/download/v0.212/ZhuqueFangsong-v0.212.zip",
        download_bytes: 5_743_932,
        download_sha256: "BB8B661A7643D2296A72D9D10530A00949419C4E527FB61783F73C2BA1A8C062",
        installed_bytes: 8_824_084,
        installed_sha256: "558C62730844FE54BA220146ED62F859D4E2880188D92D985F8921C6E3743BC4",
        zip_entry: Some("ZhuqueFangsong-Regular.ttf"),
    },
];

#[derive(Serialize)]
pub(crate) struct ReaderFontStatus {
    id: &'static str,
    label: &'static str,
    family: &'static str,
    installed: bool,
    bytes: u64,
    download_bytes: u64,
}

fn font_dir() -> Option<PathBuf> {
    let mut path = dirs::data_local_dir()?;
    path.push("ebook-reader");
    path.push("fonts");
    Some(path)
}

fn spec_by_id(id: &str) -> Option<FontSpec> {
    FONTS.iter().copied().find(|font| font.id == id)
}

fn spec_by_slot(slot: u64) -> Option<FontSpec> {
    FONTS.iter().copied().find(|font| font.slot == slot)
}

fn font_path(spec: FontSpec) -> Option<PathBuf> {
    Some(font_dir()?.join(spec.file_name))
}

fn sha256_file(path: &Path) -> Option<(u64, String)> {
    let mut file = File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        bytes = bytes.saturating_add(read as u64);
    }
    let hash = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect();
    Some((bytes, hash))
}

fn installed(spec: FontSpec) -> bool {
    font_path(spec)
        .as_deref()
        .and_then(sha256_file)
        .is_some_and(|(bytes, hash)| {
            bytes == spec.installed_bytes && hash.eq_ignore_ascii_case(spec.installed_sha256)
        })
}

fn status(spec: FontSpec) -> ReaderFontStatus {
    let path = font_path(spec);
    ReaderFontStatus {
        id: spec.id,
        label: spec.label,
        family: spec.family,
        installed: installed(spec),
        bytes: path
            .as_deref()
            .and_then(|path| path.metadata().ok())
            .map(|metadata| metadata.len())
            .unwrap_or(0),
        download_bytes: spec.download_bytes,
    }
}

#[tauri::command]
pub(crate) fn reader_font_status() -> Vec<ReaderFontStatus> {
    FONTS.iter().copied().map(status).collect()
}

fn download_to(spec: FontSpec, path: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or("无法确定字体缓存目录")?;
    std::fs::create_dir_all(parent).map_err(|error| format!("创建字体目录失败：{error}"))?;
    let download_path = parent.join(format!(".{}.download", spec.id));
    let extracted_path = parent.join(format!(".{}.font", spec.id));
    let _ = std::fs::remove_file(&download_path);
    let _ = std::fs::remove_file(&extracted_path);

    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .timeout_recv_body(Some(Duration::from_secs(180)))
        .build()
        .into();
    let mut response = agent
        .get(spec.url)
        .header("User-Agent", "kunpeng-reader")
        .call()
        .map_err(|error| format!("下载字体失败：{error}"))?;
    let mut input = response.body_mut().as_reader();
    let mut output =
        File::create(&download_path).map_err(|error| format!("创建字体临时文件失败：{error}"))?;
    std::io::copy(&mut input, &mut output).map_err(|error| format!("保存字体下载失败：{error}"))?;
    output
        .flush()
        .map_err(|error| format!("刷新字体下载失败：{error}"))?;

    let (download_bytes, download_hash) = sha256_file(&download_path).ok_or("无法校验字体下载")?;
    if download_bytes != spec.download_bytes
        || !download_hash.eq_ignore_ascii_case(spec.download_sha256)
    {
        let _ = std::fs::remove_file(&download_path);
        return Err(format!(
            "字体完整性校验失败：实际 {download_bytes} 字节/{download_hash}"
        ));
    }

    if let Some(entry_name) = spec.zip_entry {
        let archive_file =
            File::open(&download_path).map_err(|error| format!("打开字体压缩包失败：{error}"))?;
        let mut archive = zip::ZipArchive::new(archive_file)
            .map_err(|error| format!("读取字体压缩包失败：{error}"))?;
        let mut entry = archive
            .by_name(entry_name)
            .map_err(|error| format!("压缩包中找不到字体文件：{error}"))?;
        if entry.size() != spec.installed_bytes {
            return Err("字体压缩包内容大小不符合预期".into());
        }
        let mut extracted =
            File::create(&extracted_path).map_err(|error| format!("创建字体文件失败：{error}"))?;
        std::io::copy(&mut entry, &mut extracted)
            .map_err(|error| format!("解压字体失败：{error}"))?;
        extracted
            .flush()
            .map_err(|error| format!("刷新字体文件失败：{error}"))?;
    } else {
        std::fs::rename(&download_path, &extracted_path)
            .map_err(|error| format!("整理字体文件失败：{error}"))?;
    }

    let (installed_bytes, installed_hash) =
        sha256_file(&extracted_path).ok_or("无法校验解压后的字体")?;
    if installed_bytes != spec.installed_bytes
        || !installed_hash.eq_ignore_ascii_case(spec.installed_sha256)
    {
        let _ = std::fs::remove_file(&extracted_path);
        let _ = std::fs::remove_file(&download_path);
        return Err("解压后的字体完整性校验失败".into());
    }
    std::fs::rename(&extracted_path, path).map_err(|error| format!("安装字体失败：{error}"))?;
    let _ = std::fs::remove_file(&download_path);
    Ok(())
}

#[tauri::command]
pub(crate) async fn download_reader_font(font_id: String) -> Result<ReaderFontStatus, String> {
    let spec = spec_by_id(font_id.trim()).ok_or("未知字体")?;
    if installed(spec) {
        return Ok(status(spec));
    }
    let path = font_path(spec).ok_or("无法确定字体缓存目录")?;
    tauri::async_runtime::spawn_blocking(move || download_to(spec, &path))
        .await
        .map_err(|error| format!("字体下载任务失败：{error}"))??;
    Ok(status(spec))
}

pub(crate) fn read_font(slot: u64) -> Option<(Vec<u8>, String)> {
    let spec = spec_by_slot(slot)?;
    if !installed(spec) {
        return None;
    }
    let path = font_path(spec)?;
    let bytes = std::fs::read(path).ok()?;
    Some((bytes, crate::reader_protocol::guess_mime(spec.file_name)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_ids_slots_and_file_names_are_unique() {
        let mut ids = std::collections::HashSet::new();
        let mut slots = std::collections::HashSet::new();
        let mut files = std::collections::HashSet::new();
        for font in FONTS {
            assert!(ids.insert(font.id));
            assert!(slots.insert(font.slot));
            assert!(files.insert(font.file_name));
            assert_eq!(font.download_sha256.len(), 64);
            assert_eq!(font.installed_sha256.len(), 64);
        }
    }
}
