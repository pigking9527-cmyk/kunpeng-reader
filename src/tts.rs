use crate::tts_core::{build_edge_ssml, frequent_words, sha256_upper, word_cache_key, EDGE_TOKEN};
use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Serialize)]
struct TtsMark {
    at: u32,
    word: String,
}

#[derive(Serialize)]
pub(crate) struct TtsAudio {
    audio: String,
    marks: Vec<TtsMark>,
}

fn sec_ms_gec() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut ticks = now + 11_644_473_600;
    ticks -= ticks % 300;
    let ticks = (ticks as u128) * 10_000_000;
    sha256_upper(&format!("{ticks}{EDGE_TOKEN}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EdgeTtsRequest {
    text: String,
    voice: String,
    rate: i32,
}

#[tauri::command]
pub(crate) async fn edge_tts(request: EdgeTtsRequest) -> Result<TtsAudio, String> {
    edge_tts_inner(request.text, request.voice, request.rate).await
}

async fn edge_tts_inner(text: String, voice: String, rate: i32) -> Result<TtsAudio, String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::Message;

    let voice = if voice.trim().is_empty() {
        "zh-CN-XiaoxiaoNeural".to_string()
    } else {
        voice
    };
    let gec = sec_ms_gec();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let cid = sha256_upper(&format!("{nanos}conn"))[..32].to_lowercase();
    let url = format!(
        "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken={EDGE_TOKEN}&ConnectionId={cid}&Sec-MS-GEC={gec}&Sec-MS-GEC-Version=1-143.0.3650.75"
    );
    let mut req = url.into_client_request().map_err(|e| e.to_string())?;
    {
        let h = req.headers_mut();
        h.insert("Pragma", "no-cache".parse().unwrap());
        h.insert("Cache-Control", "no-cache".parse().unwrap());
        h.insert(
            "Origin",
            "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"
                .parse()
                .unwrap(),
        );
        h.insert(
            "Accept-Encoding",
            "gzip, deflate, br, zstd".parse().unwrap(),
        );
        h.insert("Accept-Language", "en-US,en;q=0.9".parse().unwrap());
        h.insert("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0".parse().unwrap());
    }
    let (mut ws, _) = tokio_tungstenite::connect_async(req)
        .await
        .map_err(|e| format!("连接微软语音失败：{e}"))?;

    let ts = chrono::Utc::now()
        .format("%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)")
        .to_string();
    let cfg = "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"true\"},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}";
    let config_msg = format!(
        "X-Timestamp:{ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{cfg}"
    );
    ws.send(Message::Text(config_msg))
        .await
        .map_err(|e| e.to_string())?;

    let rid = sha256_upper(&format!("{ts}{text}"))[..32].to_lowercase();
    let ssml = build_edge_ssml(&text, &voice, rate);
    let ssml_msg = format!(
        "X-RequestId:{rid}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{ts}\r\nPath:ssml\r\n\r\n{ssml}"
    );
    ws.send(Message::Text(ssml_msg))
        .await
        .map_err(|e| e.to_string())?;

    let mut audio: Vec<u8> = Vec::new();
    let mut marks: Vec<TtsMark> = Vec::new();
    while let Some(msg) = ws.next().await {
        match msg.map_err(|e| e.to_string())? {
            Message::Text(t) => {
                if t.contains("Path:turn.end") {
                    break;
                }
                if t.contains("Path:audio.metadata") {
                    if let Some(idx) = t.find("\r\n\r\n") {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t[idx + 4..]) {
                            if let Some(arr) = v.get("Metadata").and_then(|m| m.as_array()) {
                                for it in arr {
                                    if it.get("Type").and_then(|x| x.as_str())
                                        == Some("WordBoundary")
                                    {
                                        let off = it
                                            .pointer("/Data/Offset")
                                            .and_then(|x| x.as_u64())
                                            .unwrap_or(0);
                                        let word = it
                                            .pointer("/Data/text/Text")
                                            .and_then(|x| x.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        marks.push(TtsMark {
                                            at: (off / 10000) as u32,
                                            word,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Message::Binary(b) => {
                if b.len() >= 2 {
                    let hlen = ((b[0] as usize) << 8) | (b[1] as usize);
                    let start = 2 + hlen;
                    if start <= b.len() {
                        audio.extend_from_slice(&b[start..]);
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    let _ = ws.close(None).await;
    if audio.is_empty() {
        return Err("没有取到音频（可能网络/地区限制）".into());
    }
    use base64::Engine;
    Ok(TtsAudio {
        audio: base64::engine::general_purpose::STANDARD.encode(&audio),
        marks,
    })
}

fn word_tts_cache_dir() -> Result<std::path::PathBuf, String> {
    let mut dir = dirs::config_dir().ok_or("无法确定用户配置目录")?;
    dir.push("ebook-reader");
    dir.push("word-tts-cache");
    Ok(dir)
}

fn word_tts_cache_path(word: &str) -> Result<std::path::PathBuf, String> {
    let key = word_cache_key("en-US-JennyNeural", word);
    Ok(word_tts_cache_dir()?.join(format!("{key}.mp3")))
}

#[tauri::command]
pub(crate) async fn word_tts(text: String, cache: bool) -> Result<TtsAudio, String> {
    use base64::Engine;

    let word = text.trim();
    if word.is_empty() {
        return Err("单词为空".into());
    }
    let cache_path = word_tts_cache_path(word)?;
    if cache {
        if let Ok(audio) = std::fs::read(&cache_path) {
            if !audio.is_empty() {
                return Ok(TtsAudio {
                    audio: base64::engine::general_purpose::STANDARD.encode(audio),
                    marks: Vec::new(),
                });
            }
        }
    }

    let result = edge_tts_inner(word.to_string(), "en-US-JennyNeural".into(), 0).await?;
    if cache {
        if let Some(parent) = cache_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建语音缓存目录失败：{e}"))?;
        }
        let audio = base64::engine::general_purpose::STANDARD
            .decode(&result.audio)
            .map_err(|e| format!("解码语音缓存失败：{e}"))?;
        std::fs::write(&cache_path, audio).map_err(|e| format!("写入语音缓存失败：{e}"))?;
    }
    Ok(result)
}

#[tauri::command]
pub(crate) fn word_tts_cache_size() -> u64 {
    let Ok(dir) = word_tts_cache_dir() else {
        return 0;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.metadata().ok())
        .filter(|meta| meta.is_file())
        .map(|meta| meta.len())
        .sum()
}

#[tauri::command]
pub(crate) fn clear_word_tts_cache() -> Result<(), String> {
    let dir = word_tts_cache_dir()?;
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(());
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("mp3") {
            std::fs::remove_file(&path).map_err(|e| format!("删除语音缓存失败：{e}"))?;
        }
    }
    Ok(())
}

const FREQUENT_EN_10000: &str = include_str!("dict/frequent_en_10000.txt");

fn frequent_en_words() -> impl Iterator<Item = &'static str> {
    frequent_words(FREQUENT_EN_10000)
}

#[derive(Serialize)]
pub(crate) struct WordTtsPackStatus {
    total: usize,
    cached: usize,
    bytes: u64,
    running: bool,
    current: String,
    message: String,
}

#[derive(Default)]
pub(crate) struct WordPackState {
    running: bool,
    stop: bool,
    current: String,
    message: String,
}

#[tauri::command]
pub(crate) fn word_tts_pack_status(state: tauri::State<AppState>) -> WordTtsPackStatus {
    let mut total = 0;
    let mut cached = 0;
    let mut bytes = 0;
    for word in frequent_en_words() {
        total += 1;
        if let Ok(path) = word_tts_cache_path(word) {
            if let Ok(meta) = std::fs::metadata(path) {
                if meta.is_file() && meta.len() > 0 {
                    cached += 1;
                    bytes += meta.len();
                }
            }
        }
    }
    let pack = state.word_pack.lock().unwrap();
    WordTtsPackStatus {
        total,
        cached,
        bytes,
        running: pack.running,
        current: pack.current.clone(),
        message: pack.message.clone(),
    }
}

#[tauri::command]
pub(crate) fn word_tts_pack_missing() -> Vec<String> {
    frequent_en_words()
        .filter(|word| {
            word_tts_cache_path(word)
                .ok()
                .and_then(|path| std::fs::metadata(path).ok())
                .map(|meta| !meta.is_file() || meta.len() == 0)
                .unwrap_or(true)
        })
        .map(str::to_string)
        .collect()
}

#[tauri::command]
pub(crate) fn clear_word_tts_pack() -> Result<(), String> {
    for word in frequent_en_words() {
        let path = word_tts_cache_path(word)?;
        if path.is_file() {
            std::fs::remove_file(&path).map_err(|e| format!("删除高频词语音包失败：{e}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn pause_word_tts_pack(state: tauri::State<AppState>) {
    let mut pack = state.word_pack.lock().unwrap();
    pack.stop = true;
    if pack.running {
        pack.message = "正在暂停，当前请求完成后停止…".into();
    }
}

#[tauri::command]
pub(crate) fn start_word_tts_pack(app: tauri::AppHandle) -> Result<(), String> {
    {
        let state = app.state::<AppState>();
        let mut pack = state.word_pack.lock().unwrap();
        if pack.running {
            return Ok(());
        }
        pack.running = true;
        pack.stop = false;
        pack.current.clear();
        pack.message = "准备生成…".into();
    }

    tauri::async_runtime::spawn(async move {
        use base64::Engine;

        for word in frequent_en_words() {
            let state = app.state::<AppState>();
            {
                let mut pack = state.word_pack.lock().unwrap();
                if pack.stop {
                    pack.running = false;
                    pack.current.clear();
                    pack.message = "已暂停".into();
                    return;
                }
                pack.current = word.to_string();
                pack.message = format!("生成中：{word}");
            }

            let path = match word_tts_cache_path(word) {
                Ok(p) => p,
                Err(err) => {
                    let mut pack = state.word_pack.lock().unwrap();
                    pack.message = err;
                    continue;
                }
            };
            if path.is_file() && path.metadata().map(|m| m.len() > 0).unwrap_or(false) {
                continue;
            }

            loop {
                let state = app.state::<AppState>();
                if state.word_pack.lock().unwrap().stop {
                    let mut pack = state.word_pack.lock().unwrap();
                    pack.running = false;
                    pack.current.clear();
                    pack.message = "已暂停".into();
                    return;
                }
                match edge_tts_inner(word.to_string(), "en-US-JennyNeural".into(), 0).await {
                    Ok(result) => {
                        if let Some(parent) = path.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        match base64::engine::general_purpose::STANDARD.decode(&result.audio) {
                            Ok(audio) => {
                                let _ = std::fs::write(&path, audio);
                                break;
                            }
                            Err(err) => {
                                let mut pack = state.word_pack.lock().unwrap();
                                pack.message = format!("解码失败：{word} · {err}");
                                break;
                            }
                        }
                    }
                    Err(_) => {
                        {
                            let mut pack = state.word_pack.lock().unwrap();
                            pack.message = format!("请求失败：{word} · 3 秒后重试");
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    }
                }
            }
        }

        let state = app.state::<AppState>();
        let mut pack = state.word_pack.lock().unwrap();
        pack.running = false;
        pack.stop = false;
        pack.current.clear();
        pack.message = "已完成".into();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edge_tts_request_deserializes_as_one_object() {
        let request: EdgeTtsRequest = serde_json::from_value(serde_json::json!({
            "text": "你好",
            "voice": "zh-CN-XiaoxiaoNeural",
            "rate": 15
        }))
        .unwrap();
        assert_eq!(request.text, "你好");
        assert_eq!(request.voice, "zh-CN-XiaoxiaoNeural");
        assert_eq!(request.rate, 15);
    }
}
