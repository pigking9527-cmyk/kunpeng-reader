use base64::Engine;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const MAX_TEXT_CHARS: usize = 20_000;
const MAX_IMAGES: usize = 3;
const MAX_IMAGE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeedbackImage {
    name: String,
    mime: String,
    data: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeedbackRequest {
    kind: String,
    text: String,
    app_version: String,
    platform: String,
    images: Vec<FeedbackImage>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct FeedbackResult {
    ok: bool,
    id: String,
    message: String,
    emailed: bool,
}

fn endpoint() -> Result<String, String> {
    let value = std::env::var("KUNPENG_FEEDBACK_URL")
        .ok()
        .or_else(|| option_env!("KUNPENG_FEEDBACK_URL").map(str::to_string))
        .unwrap_or_default();
    let value = value.trim().trim_end_matches('/').to_string();
    if !(value.starts_with("https://") || value.starts_with("http://")) {
        return Err("反馈服务尚未配置，请稍后再试".to_string());
    }
    Ok(value)
}

fn validate(request: &FeedbackRequest) -> Result<(), String> {
    if request.kind != "bug" && request.kind != "feature" {
        return Err("反馈类型不正确".to_string());
    }
    let text_chars = request.text.trim().chars().count();
    if text_chars == 0 && request.images.is_empty() {
        return Err("请输入反馈内容，或至少插入一张图片".to_string());
    }
    if text_chars > MAX_TEXT_CHARS {
        return Err(format!("反馈文字不能超过 {MAX_TEXT_CHARS} 个字符"));
    }
    if request.images.len() > MAX_IMAGES {
        return Err(format!("反馈图片不能超过 {MAX_IMAGES} 张"));
    }
    for image in &request.images {
        if !matches!(
            image.mime.as_str(),
            "image/jpeg" | "image/png" | "image/webp"
        ) {
            return Err("反馈图片格式不支持".to_string());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&image.data)
            .map_err(|_| "反馈图片数据损坏".to_string())?;
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err("单张反馈图片不能超过 1 MB".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn submit_feedback(request: FeedbackRequest) -> Result<FeedbackResult, String> {
    validate(&request)?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(8)))
        .timeout_recv_response(Some(Duration::from_secs(15)))
        .timeout_recv_body(Some(Duration::from_secs(15)))
        .build()
        .into();
    let mut response = agent
        .post(&endpoint()?)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("User-Agent", "kunpeng-reader-feedback")
        .send_json(
            serde_json::to_value(&request).map_err(|error| format!("反馈内容编码失败：{error}"))?,
        )
        .map_err(|error| format!("连接反馈服务器失败：{error}"))?;
    let result: FeedbackResult = response
        .body_mut()
        .read_json()
        .map_err(|error| format!("反馈服务器返回无法解析：{error}"))?;
    if !result.ok {
        return Err(if result.message.is_empty() {
            "反馈服务器拒绝了本次提交".to_string()
        } else {
            result.message
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> FeedbackRequest {
        FeedbackRequest {
            kind: "bug".to_string(),
            text: "窗口异常".to_string(),
            app_version: "1.9.5".to_string(),
            platform: "test".to_string(),
            images: vec![],
        }
    }

    #[test]
    fn accepts_text_feedback() {
        assert!(validate(&request()).is_ok());
    }

    #[test]
    fn rejects_unknown_kind_and_oversized_image() {
        let mut value = request();
        value.kind = "other".to_string();
        assert!(validate(&value).is_err());
        value.kind = "bug".to_string();
        value.images.push(FeedbackImage {
            name: "large.jpg".to_string(),
            mime: "image/jpeg".to_string(),
            data: base64::engine::general_purpose::STANDARD.encode(vec![0; MAX_IMAGE_BYTES + 1]),
        });
        assert!(validate(&value).is_err());
    }
}
