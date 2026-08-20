use super::html::{absolute_image_url, first_non_chrome_image};
use crate::url_open;
use serde_json::Value;
use std::collections::HashMap;

// 少数派的 OG 图经常是原始 PNG，单张可超过数 MB。资讯流只需要卡片缩略图，
// rssfile 支持在同一资源上请求受控尺寸的 WebP；这样既保留真实封面，也不会
// 为了个别原图而放宽全局内存上限。
pub(super) fn compact_preview_image_url(image_url: &str) -> String {
    let Some(path) = image_url.strip_prefix("https://rssfile.sspai.com/") else {
        return image_url.to_string();
    };
    let Some((path, _)) = path.split_once('?') else {
        return image_url.to_string();
    };
    format!("https://rssfile.sspai.com/{path}?imageView2/2/w/800/h/450/format/webp/q/85")
}

pub(super) fn source_item_id(source_id: &str, item_id: &str) -> String {
    item_id
        .strip_prefix(&format!("{source_id}:"))
        .unwrap_or(item_id)
        .trim()
        .to_string()
}

pub(super) fn safe_remote_item_id(source_id: &str, item_id: &str) -> String {
    let id = source_item_id(source_id, item_id);
    if id.is_empty() || id.len() > 32 || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        String::new()
    } else {
        id
    }
}

fn markdown_first_image(markdown: &str) -> String {
    let mut cursor = 0;
    while let Some(found) = markdown[cursor..].find("![") {
        let start = cursor + found;
        let Some(url_start) = markdown[start..]
            .find("](")
            .map(|offset| start + offset + 2)
        else {
            break;
        };
        let Some(url_end) = markdown[url_start..]
            .find(')')
            .map(|offset| url_start + offset)
        else {
            break;
        };
        let candidate = markdown[url_start..url_end]
            .split_ascii_whitespace()
            .next()
            .unwrap_or_default();
        let image = absolute_image_url("https://juejin.cn/", candidate);
        if !image.is_empty() {
            return image;
        }
        cursor = url_end + 1;
    }
    String::new()
}

pub(super) fn juejin_article_image_from_json(data: &Value) -> String {
    let article = data.pointer("/data/article_info");
    let cover = https_text(article.and_then(|article| article.get("cover_image")));
    if !cover.is_empty() {
        return cover;
    }
    let markdown = value_to_text(article.and_then(|article| article.get("mark_content")));
    let image = markdown_first_image(&markdown);
    if !image.is_empty() {
        return image;
    }
    let html = value_to_text(article.and_then(|article| article.get("web_html_content")));
    first_non_chrome_image(&html, "https://juejin.cn/")
}

pub(super) fn source_image_map_from_json(source_id: &str, data: &Value) -> HashMap<String, String> {
    let entries = data
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten();
    let mut images = HashMap::new();
    for entry in entries {
        let (id, image) = match source_id {
            "zhihu" => {
                let image = https_text(entry.pointer("/children/0/thumbnail"));
                let image = if image.is_empty() {
                    https_text(entry.pointer("/target/image_area/url"))
                } else {
                    image
                };
                (value_to_text(entry.pointer("/target/id")), image)
            }
            "toutiao" => {
                let id = value_to_text(entry.pointer("/ClusterIdStr"));
                let id = if id.is_empty() {
                    value_to_text(entry.pointer("/ClusterId"))
                } else {
                    id
                };
                (id, https_text(entry.pointer("/Image/url")))
            }
            _ => unreachable!(),
        };
        if !id.is_empty() && !image.is_empty() {
            images.insert(id, image);
        }
    }
    images
}

pub(super) fn value_to_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.trim().to_string(),
        Some(Value::Number(value)) => value.to_string(),
        _ => String::new(),
    }
}

pub(super) fn https_text(value: Option<&Value>) -> String {
    let value = value_to_text(value);
    url_open::validate_https_url(&value)
        .map(str::to_string)
        .unwrap_or_default()
}
