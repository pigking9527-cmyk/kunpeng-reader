//! Windows CUDA/cuDNN large runtime downloaded on demand.

use serde::Serialize;

pub(crate) const DOWNLOAD_BYTES: u64 = if cfg!(target_os = "windows") {
    1_494_396_282
} else {
    0
};

#[cfg(target_os = "windows")]
mod windows {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::fs::{File, OpenOptions};
    use std::io::{Read, Write};
    use std::path::{Path, PathBuf};
    use std::sync::OnceLock;
    use std::time::Duration;
    use tauri::Emitter;

    const VERSION: &str = "cuda-12.8-cudnn-9.10.2-windows-x64-v1";

    #[derive(Clone, Copy)]
    struct RuntimeFile {
        name: &'static str,
        bytes: u64,
        sha256: &'static str,
    }

    #[derive(Clone, Copy)]
    struct RuntimeArchive {
        id: &'static str,
        file_name: &'static str,
        url: &'static str,
        bytes: u64,
        sha256: &'static str,
        license_name: &'static str,
        files: &'static [RuntimeFile],
    }

    const CORE_FILES: &[RuntimeFile] = &[
        RuntimeFile {
            name: "cublas64_12.dll",
            bytes: 113_716_224,
            sha256: "9513540E4EC4C51EE9E7304138C2CC255C29A8C181F9E80C38EFA25738BECD99",
        },
        RuntimeFile {
            name: "cublasLt64_12.dll",
            bytes: 674_667_520,
            sha256: "B199D1FF892A81B7FD3D57BA1781549609B41500B36008FEF326038393AD46C7",
        },
        RuntimeFile {
            name: "cufft64_11.dll",
            bytes: 276_121_600,
            sha256: "F4FEA9227B14843894AD5436725F9638B172171142C95291FC6AE7A493248221",
        },
        RuntimeFile {
            name: "nvJitLink_120_0.dll",
            bytes: 77_860_352,
            sha256: "959D3CB44527EC884DB8DC20772520B584DBE7D622D11B0530E6326417078B3E",
        },
        RuntimeFile {
            name: "cudart64_12.dll",
            bytes: 573_952,
            sha256: "C2C9A9C22A9BCBA90E261825968836787B331038047A26770CFFB7A583C28344",
        },
    ];

    const CUDNN_FILES: &[RuntimeFile] = &[
        RuntimeFile {
            name: "cudnn64_9.dll",
            bytes: 266_288,
            sha256: "9EDBCDFF73B0AF070EB160B2CE66E59FECA04AA017351D8EEDCC5E8E149967D2",
        },
        RuntimeFile {
            name: "cudnn_adv64_9.dll",
            bytes: 282_445_872,
            sha256: "F202E8FF36209AC4292FE2EF79D4539487495B3B948F0C978CC63298F43A1850",
        },
        RuntimeFile {
            name: "cudnn_cnn64_9.dll",
            bytes: 4_618_272,
            sha256: "3F03DEC3B81F137F049E1D1C06FF469248EEF54FF9424B3B9045FC0F69559D1A",
        },
        RuntimeFile {
            name: "cudnn_engines_precompiled64_9.dll",
            bytes: 513_926_688,
            sha256: "EBC2C1F74366B029A4350F7F9A3B109CCD5AA9B4AE02527950793DD29F7B74FB",
        },
        RuntimeFile {
            name: "cudnn_engines_runtime_compiled64_9.dll",
            bytes: 20_201_008,
            sha256: "93AB6351CA0F2B6CA842F83D284E56C427525778C14657229801A13CF8121BD8",
        },
        RuntimeFile {
            name: "cudnn_graph64_9.dll",
            bytes: 2_420_256,
            sha256: "A933EFEB280A3252297F92D79F7E83003BCBC6F665872D11645D1DBBAB9CB598",
        },
        RuntimeFile {
            name: "cudnn_heuristic64_9.dll",
            bytes: 56_823_328,
            sha256: "458175F12771A35DE0EA39C04250D727C2424D42A7FFE0BC987AE81204748FBA",
        },
        RuntimeFile {
            name: "cudnn_ops64_9.dll",
            bytes: 126_508_576,
            sha256: "851D8F4191A24B322B0BE738D191A3159455F0DA4DB47A19F5CC7AD6E55EDF61",
        },
    ];

    const ARCHIVES: &[RuntimeArchive] = &[
        RuntimeArchive {
            id: "cuda-core",
            file_name: "Kunpeng-Reader-CUDA-12.8-core-Windows-x64.zip",
            url: "https://github.com/pigking9527-cmyk/kunpeng-reader/releases/download/cuda-runtime-windows-v1/Kunpeng-Reader-CUDA-12.8-core-Windows-x64.zip",
            bytes: 797_349_529,
            sha256: "0FD2F21EC3FCCE4BCC668F7941D0722B88A79C79F8BE8EF8D43E5929052E83AB",
            license_name: "NVIDIA-CUDA-License.txt",
            files: CORE_FILES,
        },
        RuntimeArchive {
            id: "cudnn",
            file_name: "Kunpeng-Reader-cuDNN-9.10.2-Windows-x64.zip",
            url: "https://github.com/pigking9527-cmyk/kunpeng-reader/releases/download/cuda-runtime-windows-v1/Kunpeng-Reader-cuDNN-9.10.2-Windows-x64.zip",
            bytes: 697_046_753,
            sha256: "55180B8269C5764C4BD549665C6C8183FF9BEA6811757145DAD402027FA6CD9D",
            license_name: "NVIDIA-cuDNN-License.txt",
            files: CUDNN_FILES,
        },
    ];

    #[derive(Clone, Serialize)]
    struct DownloadProgress {
        stage: &'static str,
        downloaded_bytes: u64,
        total_bytes: u64,
    }

    fn dir() -> Option<PathBuf> {
        let mut path = dirs::data_local_dir()?;
        path.push("ebook-reader");
        path.push("gpu-runtime");
        path.push(VERSION);
        Some(path)
    }

    fn files() -> impl Iterator<Item = RuntimeFile> {
        ARCHIVES
            .iter()
            .flat_map(|archive| archive.files.iter().copied())
    }

    fn archive_downloaded_bytes(downloads: &Path, spec: RuntimeArchive) -> u64 {
        let complete = downloads.join(spec.file_name);
        if std::fs::metadata(&complete)
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() == spec.bytes)
        {
            return spec.bytes;
        }
        std::fs::metadata(complete.with_extension("zip.download"))
            .map(|metadata| metadata.len().min(spec.bytes))
            .unwrap_or(0)
    }

    pub(super) fn downloaded_bytes() -> u64 {
        let Some(destination) = dir() else {
            return 0;
        };
        let Some(parent) = destination.parent() else {
            return 0;
        };
        let downloads = parent.join("downloads");
        ARCHIVES
            .iter()
            .map(|spec| archive_downloaded_bytes(&downloads, *spec))
            .sum()
    }

    fn hash_file(path: &Path) -> Result<(u64, String), String> {
        let mut input = File::open(path).map_err(|error| format!("打开文件失败：{error}"))?;
        let mut hasher = Sha256::new();
        let mut bytes = 0_u64;
        let mut buffer = [0_u8; 1024 * 1024];
        loop {
            let read = input
                .read(&mut buffer)
                .map_err(|error| format!("读取文件失败：{error}"))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            bytes = bytes.saturating_add(read as u64);
        }
        Ok((
            bytes,
            hasher
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02X}"))
                .collect(),
        ))
    }

    pub(super) fn installed() -> bool {
        let Some(dir) = dir() else {
            return false;
        };
        if std::fs::read_to_string(dir.join(".installed"))
            .ok()
            .as_deref()
            != Some(VERSION)
        {
            return false;
        }
        files().all(|file| {
            dir.join(file.name)
                .metadata()
                .is_ok_and(|metadata| metadata.is_file() && metadata.len() == file.bytes)
        })
    }

    pub(super) fn prepare() {
        static PATH_READY: OnceLock<()> = OnceLock::new();
        if !installed() {
            return;
        }
        PATH_READY.get_or_init(|| {
            let Some(dir) = dir() else {
                return;
            };
            let mut paths = vec![dir];
            if let Some(existing) = std::env::var_os("PATH") {
                paths.extend(std::env::split_paths(&existing));
            }
            if let Ok(joined) = std::env::join_paths(paths) {
                std::env::set_var("PATH", joined);
            }
        });
    }

    fn emit(app: &tauri::AppHandle, stage: &'static str, downloaded_bytes: u64) {
        let _ = app.emit(
            "semantic-gpu-runtime-progress",
            DownloadProgress {
                stage,
                downloaded_bytes,
                total_bytes: super::DOWNLOAD_BYTES,
            },
        );
    }

    fn retry_download_error(spec: RuntimeArchive, partial: &Path, error: &str) -> String {
        let saved = std::fs::metadata(partial)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        format!(
            "下载 GPU 组件失败：{error}。已保留 {:.1} MiB，重新点击安装会从断点继续：{}",
            saved as f64 / (1024.0 * 1024.0),
            spec.file_name
        )
    }

    fn download(
        app: &tauri::AppHandle,
        spec: RuntimeArchive,
        path: &Path,
        prior: u64,
    ) -> Result<(), String> {
        if path.is_file()
            && hash_file(path).is_ok_and(|(bytes, hash)| {
                bytes == spec.bytes && hash.eq_ignore_ascii_case(spec.sha256)
            })
        {
            emit(app, spec.id, prior + spec.bytes);
            return Ok(());
        }
        let partial = path.with_extension("zip.download");
        if std::fs::metadata(&partial).is_ok_and(|metadata| metadata.len() > spec.bytes) {
            let _ = std::fs::remove_file(&partial);
        }
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(30)))
            .timeout_recv_response(Some(Duration::from_secs(15 * 60)))
            .timeout_recv_body(Some(Duration::from_secs(12 * 60 * 60)))
            .build()
            .into();
        let mut last_error = String::new();
        'attempts: for attempt in 1..=5 {
            let resume_from = std::fs::metadata(&partial)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            if resume_from == spec.bytes {
                break;
            }
            emit(app, spec.id, prior + resume_from);
            let mut request = agent.get(spec.url).header("User-Agent", "kunpeng-reader");
            if resume_from > 0 {
                request = request.header("Range", format!("bytes={resume_from}-"));
            }
            let mut response = match request.call() {
                Ok(response) => response,
                Err(error) => {
                    last_error = error.to_string();
                    if attempt < 5 {
                        std::thread::sleep(Duration::from_secs(2));
                        continue;
                    }
                    return Err(retry_download_error(spec, &partial, &last_error));
                }
            };
            let status = response.status().as_u16();
            let append = if resume_from > 0 && status == 206 {
                let expected = format!("bytes {resume_from}-");
                response
                    .headers()
                    .get("content-range")
                    .and_then(|value| value.to_str().ok())
                    .is_some_and(|value| value.starts_with(&expected))
            } else {
                false
            };
            if resume_from > 0 && status == 206 && !append {
                return Err(retry_download_error(
                    spec,
                    &partial,
                    "服务器返回的断点位置不匹配",
                ));
            }
            let mut output = OpenOptions::new()
                .create(true)
                .write(true)
                .append(append)
                .truncate(!append)
                .open(&partial)
                .map_err(|error| format!("创建下载文件失败：{error}"))?;
            let mut downloaded = if append { resume_from } else { 0 };
            let mut reported = downloaded;
            let mut input = response.body_mut().as_reader();
            let mut buffer = [0_u8; 1024 * 1024];
            loop {
                let read = match input.read(&mut buffer) {
                    Ok(read) => read,
                    Err(error) => {
                        let _ = output.flush();
                        last_error = error.to_string();
                        if attempt < 5 {
                            std::thread::sleep(Duration::from_secs(2));
                            continue 'attempts;
                        }
                        return Err(retry_download_error(spec, &partial, &last_error));
                    }
                };
                if read == 0 {
                    break;
                }
                output
                    .write_all(&buffer[..read])
                    .map_err(|error| format!("保存下载失败：{error}"))?;
                downloaded = downloaded.saturating_add(read as u64);
                if downloaded > spec.bytes {
                    let _ = std::fs::remove_file(&partial);
                    return Err(format!("GPU 组件下载大小异常：{}", spec.file_name));
                }
                if downloaded.saturating_sub(reported) >= 4 * 1024 * 1024 {
                    reported = downloaded;
                    emit(app, spec.id, prior + downloaded);
                }
            }
            output
                .flush()
                .map_err(|error| format!("刷新下载失败：{error}"))?;
            if downloaded == spec.bytes {
                break;
            }
            last_error = format!("连接提前结束（已下载 {downloaded} / {} 字节）", spec.bytes);
            if attempt < 5 {
                std::thread::sleep(Duration::from_secs(2));
            }
        }
        if std::fs::metadata(&partial)
            .ok()
            .map(|metadata| metadata.len())
            != Some(spec.bytes)
        {
            return Err(retry_download_error(spec, &partial, &last_error));
        }
        let (bytes, hash) = hash_file(&partial)?;
        if bytes != spec.bytes || !hash.eq_ignore_ascii_case(spec.sha256) {
            let _ = std::fs::remove_file(&partial);
            return Err(format!("GPU 组件完整性校验失败：{}", spec.file_name));
        }
        std::fs::rename(&partial, path).map_err(|error| format!("整理下载失败：{error}"))?;
        emit(app, spec.id, prior + spec.bytes);
        Ok(())
    }
    fn extract(spec: RuntimeArchive, path: &Path, destination: &Path) -> Result<(), String> {
        let archive_file =
            File::open(path).map_err(|error| format!("打开 GPU 组件失败：{error}"))?;
        let mut archive = zip::ZipArchive::new(archive_file)
            .map_err(|error| format!("读取压缩包失败：{error}"))?;
        for expected in spec.files {
            let mut entry = archive
                .by_name(expected.name)
                .map_err(|error| format!("GPU 组件缺少 {}：{error}", expected.name))?;
            if entry.size() != expected.bytes {
                return Err(format!("文件大小不匹配：{}", expected.name));
            }
            let output_path = destination.join(expected.name);
            let mut output =
                File::create(&output_path).map_err(|error| format!("创建运行库失败：{error}"))?;
            std::io::copy(&mut entry, &mut output)
                .map_err(|error| format!("解压运行库失败：{error}"))?;
            output
                .flush()
                .map_err(|error| format!("刷新运行库失败：{error}"))?;
            let (bytes, hash) = hash_file(&output_path)?;
            if bytes != expected.bytes || !hash.eq_ignore_ascii_case(expected.sha256) {
                return Err(format!("GPU 运行库完整性校验失败：{}", expected.name));
            }
        }
        if let Ok(mut license) = archive.by_name(spec.license_name) {
            let mut output = File::create(destination.join(spec.license_name))
                .map_err(|error| format!("创建许可证失败：{error}"))?;
            std::io::copy(&mut license, &mut output)
                .map_err(|error| format!("保存许可证失败：{error}"))?;
        }
        Ok(())
    }

    pub(super) fn install(app: &tauri::AppHandle) -> Result<(), String> {
        let destination = dir().ok_or("无法确定 GPU 运行库目录")?;
        let parent = destination.parent().ok_or("无法确定 GPU 运行库父目录")?;
        std::fs::create_dir_all(parent).map_err(|error| format!("创建 GPU 目录失败：{error}"))?;
        let downloads = parent.join("downloads");
        std::fs::create_dir_all(&downloads)
            .map_err(|error| format!("创建下载目录失败：{error}"))?;
        let staging = parent.join(format!(".installing-{}", std::process::id()));
        let backup = parent.join(format!(".previous-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&staging);
        let _ = std::fs::remove_dir_all(&backup);
        std::fs::create_dir_all(&staging)
            .map_err(|error| format!("创建临时安装目录失败：{error}"))?;
        let result = (|| {
            let mut completed = 0_u64;
            for spec in ARCHIVES {
                let path = downloads.join(spec.file_name);
                download(app, *spec, &path, completed)?;
                extract(*spec, &path, &staging)?;
                completed = completed.saturating_add(spec.bytes);
            }
            for expected in files() {
                let (bytes, hash) = hash_file(&staging.join(expected.name))?;
                if bytes != expected.bytes || !hash.eq_ignore_ascii_case(expected.sha256) {
                    return Err(format!("GPU 运行库最终校验失败：{}", expected.name));
                }
            }
            std::fs::write(staging.join(".installed"), VERSION)
                .map_err(|error| format!("写入安装标记失败：{error}"))?;
            if destination.exists() {
                std::fs::rename(&destination, &backup)
                    .map_err(|error| format!("备份旧运行库失败：{error}"))?;
            }
            if let Err(error) = std::fs::rename(&staging, &destination) {
                if backup.exists() {
                    let _ = std::fs::rename(&backup, &destination);
                }
                return Err(format!("启用 GPU 运行库失败：{error}"));
            }
            let _ = std::fs::remove_dir_all(&backup);
            for spec in ARCHIVES {
                let _ = std::fs::remove_file(downloads.join(spec.file_name));
            }
            emit(app, "complete", super::DOWNLOAD_BYTES);
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        result
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn catalog_is_complete_and_unique() {
            let mut names = std::collections::HashSet::new();
            for file in files() {
                assert!(names.insert(file.name));
                assert_eq!(file.sha256.len(), 64);
                assert!(file.bytes > 0);
            }
            assert_eq!(
                ARCHIVES.iter().map(|item| item.bytes).sum::<u64>(),
                super::super::DOWNLOAD_BYTES
            );
            assert!(ARCHIVES.iter().all(|item| item.sha256.len() == 64));
        }

        #[test]
        fn failed_download_keeps_the_partial_file_for_resume() {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let partial = std::env::temp_dir().join(format!(
                "kunpeng-gpu-runtime-resume-{}-{nonce}.download",
                std::process::id()
            ));
            std::fs::write(&partial, vec![0_u8; 1024]).unwrap();
            let message = retry_download_error(ARCHIVES[0], &partial, "timeout: receive response");
            assert!(partial.is_file());
            assert_eq!(std::fs::metadata(&partial).unwrap().len(), 1024);
            assert!(message.contains("已保留"));
            assert!(message.contains("从断点继续"));
            let _ = std::fs::remove_file(partial);
        }

        #[test]
        fn saved_download_progress_is_read_without_hashing_the_large_archive() {
            let downloads =
                std::env::temp_dir().join(format!("kunpeng-gpu-progress-{}", std::process::id()));
            std::fs::create_dir_all(&downloads).unwrap();
            let partial = downloads
                .join(ARCHIVES[0].file_name)
                .with_extension("zip.download");
            std::fs::write(&partial, vec![0_u8; 4096]).unwrap();
            assert_eq!(archive_downloaded_bytes(&downloads, ARCHIVES[0]), 4096);
            let _ = std::fs::remove_dir_all(downloads);
        }
    }
}

pub(crate) fn prepare() {
    #[cfg(target_os = "windows")]
    windows::prepare();
}

pub(crate) fn install_available() -> bool {
    cfg!(target_os = "windows")
}

#[cfg(target_os = "windows")]
pub(crate) fn downloaded_bytes() -> u64 {
    windows::downloaded_bytes()
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn downloaded_bytes() -> u64 {
    0
}

#[tauri::command]
pub(crate) async fn install_semantic_gpu_runtime(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let task_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || windows::install(&task_app))
            .await
            .map_err(|error| format!("GPU 组件安装任务失败：{error}"))??;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("当前版本只支持在 Windows 中自动安装 CUDA 运行依赖".into())
    }
}
