use crate::RES_BASE;
use std::collections::{HashMap, HashSet};

/// 把相对路径 rel 基于 base_dir 解析成归档内的绝对路径（处理 ./ 和 ../）。
pub(crate) fn resolve_rel(base_dir: &str, rel: &str) -> String {
    let mut parts: Vec<&str> = if rel.starts_with('/') {
        Vec::new()
    } else {
        base_dir.split('/').filter(|s| !s.is_empty()).collect()
    };
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

/// 把一个资源/链接的相对 URL 重写为合并页可用的地址。
/// is_href=true 表示这是导航链接（<a href>）：指向某章节则改为页面内锚点。
pub(crate) fn rewrite_url(
    value: &str,
    is_href: bool,
    id: u64,
    base_dir: &str,
    chapter_map: &HashMap<String, usize>,
) -> String {
    let v = value.trim();
    if v.is_empty()
        || v.starts_with("http:")
        || v.starts_with("https:")
        || v.starts_with("data:")
        || v.starts_with("blob:")
        || v.starts_with("mailto:")
        || v.starts_with("tel:")
        || v.starts_with("//")
        || v.starts_with('#')
    {
        return value.to_string();
    }
    let (path_part, frag) = match v.split_once('#') {
        Some((p, f)) => (p, Some(f)),
        None => (v, None),
    };
    let abs = resolve_rel(base_dir, path_part);
    if is_href {
        if let Some(idx) = chapter_map.get(&abs) {
            return match frag {
                Some(f) => format!("#c{idx}~{f}"),
                None => format!("#c{idx}"),
            };
        }
    }
    let mut url = format!("{RES_BASE}/res/{id}/{}", encode_path(&abs));
    if let Some(f) = frag {
        url.push('#');
        url.push_str(f);
    }
    url
}

/// 重写 HTML 里 src/href/xlink:href/poster 等属性中的相对 URL。
pub(crate) fn rewrite_attrs(
    html: &str,
    id: u64,
    base_dir: &str,
    chapter_map: &HashMap<String, usize>,
) -> String {
    const PATTERNS: [(&str, char); 7] = [
        (" src=\"", '"'),
        (" src='", '\''),
        (" href=\"", '"'),
        (" href='", '\''),
        (" xlink:href=\"", '"'),
        (" xlink:href='", '\''),
        (" poster=\"", '"'),
    ];
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    'outer: while i < html.len() {
        for (pat, quote) in PATTERNS.iter() {
            if html[i..].starts_with(pat) {
                out.push_str(pat);
                let vstart = i + pat.len();
                if let Some(end) = html[vstart..].find(*quote) {
                    let value = &html[vstart..vstart + end];
                    let is_href = pat.contains("href");
                    out.push_str(&rewrite_url(value, is_href, id, base_dir, chapter_map));
                    out.push(*quote);
                    i = vstart + end + 1;
                } else {
                    i = vstart;
                }
                continue 'outer;
            }
        }
        let ch = html[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// 重写 CSS 里 url(...) 中的相对地址（内联 style 与 <style> 块）。
pub(crate) fn rewrite_css_url(html: &str, id: u64, base_dir: &str) -> String {
    let empty = HashMap::new();
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    while i < html.len() {
        if html[i..].starts_with("url(") {
            if let Some(end) = html[i + 4..].find(')') {
                let raw = html[i + 4..i + 4 + end].trim();
                let (q, inner) = if raw.len() >= 2 && raw.starts_with('"') && raw.ends_with('"') {
                    ("\"", &raw[1..raw.len() - 1])
                } else if raw.len() >= 2 && raw.starts_with('\'') && raw.ends_with('\'') {
                    ("'", &raw[1..raw.len() - 1])
                } else {
                    ("", raw)
                };
                out.push_str("url(");
                out.push_str(q);
                out.push_str(&rewrite_url(inner, false, id, base_dir, &empty));
                out.push_str(q);
                out.push(')');
                i = i + 4 + end + 1;
                continue;
            }
        }
        let ch = html[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// 取属性值（在单个标签字符串里）。
fn attr_value(tag: &str, key: &str) -> Option<String> {
    for q in ['"', '\''] {
        let needle = format!("{key}={q}");
        if let Some(p) = tag.find(&needle) {
            let s = p + needle.len();
            if let Some(e) = tag[s..].find(q) {
                return Some(tag[s..s + e].to_string());
            }
        }
    }
    None
}

/// Extract local EPUB stylesheet archive paths from a sanitized chapter head.
///
/// The returned paths are decoded exactly as the custom protocol will decode
/// them. External stylesheets and resources belonging to another book are
/// deliberately ignored, so callers can safely prewarm only the bytes that the
/// local `reader` protocol would otherwise read on demand.
pub(crate) fn collect_local_stylesheet_links(head: &str, id: u64) -> Vec<(String, String)> {
    let prefix = format!("{RES_BASE}/res/{id}/");
    let mut links = Vec::new();
    let mut seen = HashSet::new();
    let mut offset = 0;
    while let Some(relative_start) = head[offset..].find("<link") {
        let start = offset + relative_start;
        let Some(relative_end) = head[start..].find('>') else {
            break;
        };
        let tag = &head[start..start + relative_end + 1];
        let is_stylesheet = attr_value(tag, "rel")
            .map(|rel| rel.eq_ignore_ascii_case("stylesheet"))
            .unwrap_or(false);
        if is_stylesheet {
            if let Some(href) = attr_value(tag, "href") {
                if let Some(encoded_path) = href.strip_prefix(&prefix) {
                    let encoded_path = encoded_path
                        .split_once('#')
                        .map(|(path, _)| path)
                        .unwrap_or(encoded_path);
                    let path = percent_decode(encoded_path);
                    if !path.is_empty() && seen.insert(path.clone()) {
                        links.push((href, path));
                    }
                }
            }
        }
        offset = start + relative_end + 1;
    }
    links
}

pub(crate) fn collect_local_stylesheet_paths(head: &str, id: u64) -> Vec<String> {
    collect_local_stylesheet_links(head, id)
        .into_iter()
        .map(|(_, path)| path)
        .collect()
}

/// Replace prepared local stylesheet links with rewritten CSS text.
/// External, imported, oversized or otherwise unsupported styles stay on the
/// existing link-loading path because the caller simply omits them from the map.
pub(crate) fn inline_local_stylesheet_links(
    head: &str,
    id: u64,
    stylesheets: &HashMap<String, String>,
) -> String {
    if stylesheets.is_empty() {
        return head.to_string();
    }
    let prefix = format!("{RES_BASE}/res/{id}/");
    let mut output =
        String::with_capacity(head.len() + stylesheets.values().map(String::len).sum::<usize>());
    let mut offset = 0;
    while let Some(relative_start) = head[offset..].find("<link") {
        let start = offset + relative_start;
        output.push_str(&head[offset..start]);
        let Some(relative_end) = head[start..].find('>') else {
            output.push_str(&head[start..]);
            return output;
        };
        let end = start + relative_end + 1;
        let tag = &head[start..end];
        let replacement = attr_value(tag, "rel")
            .filter(|rel| rel.eq_ignore_ascii_case("stylesheet"))
            .and_then(|_| attr_value(tag, "href"))
            .filter(|href| href.starts_with(&prefix))
            .and_then(|href| stylesheets.get(&href));
        if let Some(css) = replacement {
            output.push_str("<style");
            if let Some(media) = attr_value(tag, "media").filter(|media| {
                media.chars().all(|ch| {
                    ch.is_alphanumeric()
                        || ch.is_ascii_whitespace()
                        || matches!(
                            ch,
                            '(' | ')' | '[' | ']' | ':' | '.' | ',' | '-' | '_' | '/'
                        )
                })
            }) {
                output.push_str(" media=\"");
                output.push_str(&media);
                output.push('"');
            }
            output.push('>');
            output.push_str(css);
            output.push_str("</style>");
        } else {
            output.push_str(tag);
        }
        offset = end;
    }
    output.push_str(&head[offset..]);
    output
}

/// 从一章 HTML 里收集 <link rel=stylesheet> 与 <style> 块到合并页头部（去重）。
pub(crate) fn collect_head_assets(html: &str, head: &mut String, seen: &mut HashSet<String>) {
    let mut i = 0;
    while let Some(p) = html[i..].find("<link") {
        let start = i + p;
        if let Some(e) = html[start..].find('>') {
            let tag = &html[start..start + e + 1];
            let key = attr_value(tag, "href").unwrap_or_else(|| tag.to_string());
            if seen.insert(format!("link:{key}")) {
                head.push_str(tag);
                head.push('\n');
            }
            i = start + e + 1;
        } else {
            break;
        }
    }

    let mut j = 0;
    while let Some(p) = html[j..].find("<style") {
        let start = j + p;
        if let Some(e) = html[start..].find("</style>") {
            let block = &html[start..start + e + "</style>".len()];
            if seen.insert(format!("style:{block}")) {
                head.push_str(block);
                head.push('\n');
            }
            j = start + e + "</style>".len();
        } else {
            break;
        }
    }
}

/// 取 <body> 内部内容；没有 body 标签则返回整段。
pub(crate) fn extract_body_inner(html: &str) -> &str {
    if let Some(bs) = html.find("<body") {
        if let Some(gt) = html[bs..].find('>') {
            let start = bs + gt + 1;
            if let Some(be) = html[start..].find("</body>") {
                return &html[start..start + be];
            }
            return &html[start..];
        }
    }
    html
}

fn encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub(crate) fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) =
                u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
            {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub(crate) fn guess_mime(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "html" | "xhtml" | "htm" => "text/html",
        "css" => "text/css",
        "js" => "text/javascript",
        "json" => "application/json",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_archive_paths() {
        assert_eq!(resolve_rel("OPS/ch1", "../img/pic.png"), "OPS/img/pic.png");
        assert_eq!(resolve_rel("OPS/ch1", "./a/../b.css"), "OPS/ch1/b.css");
        assert_eq!(resolve_rel("OPS/ch1", "/root.css"), "root.css");
    }

    #[test]
    fn rewrites_resource_and_chapter_urls() {
        let mut map = HashMap::new();
        map.insert("OPS/ch2.xhtml".to_string(), 1usize);
        assert_eq!(
            rewrite_url("ch2.xhtml#frag", true, 7, "OPS", &map),
            "#c1~frag"
        );
        assert_eq!(
            rewrite_url("../img/封面 图.png", false, 7, "OPS/Text", &map),
            format!("{RES_BASE}/res/7/OPS/img/%E5%B0%81%E9%9D%A2%20%E5%9B%BE.png")
        );
        assert_eq!(
            rewrite_url("https://example.com/a.png", false, 7, "", &map),
            "https://example.com/a.png"
        );
    }

    #[test]
    fn rewrites_html_attrs_and_css_urls() {
        let map = HashMap::new();
        let html = r#"<img src="../img/a b.png"><a href="next.xhtml">next</a>"#;
        let out = rewrite_attrs(html, 9, "OPS/Text", &map);
        assert!(out.contains(&format!("{RES_BASE}/res/9/OPS/img/a%20b.png")));
        assert!(out.contains(&format!("{RES_BASE}/res/9/OPS/Text/next.xhtml")));

        let css = "body{background:url('../img/bg.png')}";
        assert!(rewrite_css_url(css, 9, "OPS/Text").contains("/res/9/OPS/img/bg.png"));
    }

    #[test]
    fn resource_base_matches_webview_platform() {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        assert_eq!(RES_BASE, "reader://localhost");

        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        assert_eq!(RES_BASE, "http://reader.localhost");
    }

    #[test]
    fn extracts_head_assets_body_and_mime() {
        let html = r#"<html><head><link href="a.css"><style>p{}</style></head><body><p>正文</p></body></html>"#;
        let mut head = String::new();
        let mut seen = HashSet::new();
        collect_head_assets(html, &mut head, &mut seen);
        collect_head_assets(html, &mut head, &mut seen);
        assert_eq!(head.matches("<link").count(), 1);
        assert_eq!(head.matches("<style").count(), 1);
        assert_eq!(extract_body_inner(html), "<p>正文</p>");
        assert_eq!(guess_mime("font.woff2"), "font/woff2");
    }

    #[test]
    fn extracts_only_local_stylesheets_for_the_current_book() {
        let head = format!(
            r#"<link rel="stylesheet" href="{RES_BASE}/res/7/OPS/css/main%20theme.css">
<link rel='STYLESHEET' href='{RES_BASE}/res/7/OPS/css/print.css#sheet'>
<link rel="stylesheet" href="{RES_BASE}/res/8/other.css">
<link rel="stylesheet" href="https://example.test/remote.css">
<link rel="preload" href="{RES_BASE}/res/7/ignored.css">
<link rel="stylesheet" href="{RES_BASE}/res/7/OPS/css/main%20theme.css">"#
        );

        assert_eq!(
            collect_local_stylesheet_paths(&head, 7),
            vec![
                "OPS/css/main theme.css".to_string(),
                "OPS/css/print.css".to_string()
            ]
        );
        assert_eq!(
            collect_local_stylesheet_links(&head, 7),
            vec![
                (
                    format!("{RES_BASE}/res/7/OPS/css/main%20theme.css"),
                    "OPS/css/main theme.css".to_string()
                ),
                (
                    format!("{RES_BASE}/res/7/OPS/css/print.css#sheet"),
                    "OPS/css/print.css".to_string()
                )
            ]
        );
    }

    #[test]
    fn inlines_only_prepared_stylesheets_for_the_current_book() {
        let local = format!("{RES_BASE}/res/7/OPS/css/main.css");
        let other = format!("{RES_BASE}/res/8/other.css");
        let head = format!(
            r#"<link media="screen and (min-width: 600px)" href="{local}" rel="stylesheet">
<link rel="stylesheet" href="{other}">
<link rel="stylesheet" href="https://example.test/remote.css">"#
        );
        let stylesheets = HashMap::from([(local.clone(), "p{color:red}".to_string())]);
        let inlined = inline_local_stylesheet_links(&head, 7, &stylesheets);
        assert!(inlined
            .contains(r#"<style media="screen and (min-width: 600px)">p{color:red}</style>"#));
        assert!(!inlined.contains(&format!("href=\"{local}\"")));
        assert!(inlined.contains(&format!("href=\"{other}\"")));
        assert!(inlined.contains("https://example.test/remote.css"));
    }
}
