use crate::text_chapters::{build_md_chapters, build_txt_chapters};
use crate::{book, AppState, RES_BASE};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// 去掉 HTML 标签，得到纯文本（合并连续空白）。
pub(crate) fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut last_ws = false;
    for character in html.chars() {
        if character == '<' {
            in_tag = true;
            continue;
        }
        if character == '>' {
            in_tag = false;
            continue;
        }
        if in_tag {
            continue;
        }
        if character.is_whitespace() {
            if !last_ws {
                out.push(' ');
                last_ws = true;
            }
        } else {
            out.push(character);
            last_ws = false;
        }
    }
    out
}

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
pub(crate) fn attr_value(tag: &str, key: &str) -> Option<String> {
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

pub(crate) fn encode_path(s: &str) -> String {
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
    let m = match ext.as_str() {
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
    };
    m.to_string()
}

pub(crate) fn is_md(format: &str) -> bool {
    matches!(format, "md" | "markdown")
}

pub(crate) fn md_to_html(text: &str) -> String {
    use pulldown_cmark::{html, Options, Parser};
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_FOOTNOTES);
    let mut out = String::new();
    html::push_html(&mut out, Parser::new_ext(text, opts));
    out
}

pub(crate) fn is_mobi(format: &str) -> bool {
    matches!(format, "mobi" | "azw3" | "azw")
}

fn strip_html_tags(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn mobi_chunk_title(html: &str) -> Option<String> {
    for tag in ["h1", "h2", "h3"] {
        let open = format!("<{tag}");
        if let Some(s) = html.find(&open) {
            if let Some(gt) = html[s..].find('>') {
                let inner = s + gt + 1;
                if let Some(e) = html[inner..].find(&format!("</{tag}>")) {
                    let t = strip_html_tags(&html[inner..inner + e]);
                    let t = t.trim();
                    if !t.is_empty() {
                        return Some(t.chars().take(40).collect());
                    }
                }
            }
        }
    }
    None
}

/// 把 MOBI/AZW3 整本 HTML 按分页符 <mbp:pagebreak> 切成章节；切不出就整本一章。
pub(crate) fn split_mobi_html(html: &str) -> Vec<(String, String)> {
    let parts: Vec<&str> = html.split("<mbp:pagebreak").collect();
    let chunks: Vec<String> = if parts.len() >= 3 {
        parts
            .iter()
            .enumerate()
            .map(|(i, p)| {
                if i == 0 {
                    (*p).to_string()
                } else {
                    match p.find('>') {
                        Some(j) => p[j + 1..].to_string(),
                        None => (*p).to_string(),
                    }
                }
            })
            .filter(|s| !s.trim().is_empty())
            .collect()
    } else {
        vec![html.to_string()]
    };
    let mut out = Vec::new();
    for (i, c) in chunks.into_iter().enumerate() {
        let title = mobi_chunk_title(&c).unwrap_or_else(|| format!("第 {} 章", i + 1));
        out.push((title, c));
    }
    if out.is_empty() {
        out.push(("正文".to_string(), html.to_string()));
    }
    out
}

/// 读取并切分 MOBI/AZW3 内容为章节。mobi 解析对个别文件可能 panic，用 catch_unwind 兜住。
pub(crate) fn mobi_chapters(path: &std::path::Path) -> Vec<(String, String)> {
    let p = path.to_path_buf();
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let Ok(m) = mobi::Mobi::from_path(&p) else {
            return vec![(
                "正文".to_string(),
                "<p>无法解析该 MOBI/AZW3 文件。</p>".to_string(),
            )];
        };
        let content = m.content_as_string_lossy();
        let body = extract_body_inner(&content);
        let body = if body.trim().is_empty() {
            content.as_str()
        } else {
            body
        };
        split_mobi_html(body)
    }))
    .unwrap_or_else(|_| {
        vec![(
            "正文".to_string(),
            "<p>解析该 MOBI/AZW3 文件时出错（可能是 DRM 或暂不支持的格式）。</p>".to_string(),
        )]
    })
}

/// 取（并缓存）一本 txt/md/mobi 的切分章节。
pub(crate) fn get_txt_chapters(state: &AppState, id: u64) -> Option<Arc<Vec<(String, String)>>> {
    {
        let c = state.txt_chapters.lock().unwrap();
        if let Some(v) = c.get(&id) {
            return Some(v.clone());
        }
    }
    let (path, format) = {
        let lib = state.library.lock().unwrap();
        let b = lib.get(id)?;
        (b.path.clone(), b.format.clone())
    };
    let chapters = if is_mobi(&format) {
        mobi_chapters(&path)
    } else {
        let bytes = std::fs::read(&path).ok()?;
        let text = book::normalize_text(&book::decode_bytes(&bytes));
        if is_md(&format) {
            build_md_chapters(&text)
        } else {
            build_txt_chapters(&text)
        }
    };
    let arc = Arc::new(chapters);
    state.txt_chapters.lock().unwrap().insert(id, arc.clone());
    Some(arc)
}

/// 把纯文本段落化为合并阅读页用的正文 HTML（每段一个 <p>，首行缩进）。
pub(crate) fn txt_body(text: &str) -> String {
    let mut body = String::new();
    for para in text.split('\n') {
        let para = para.trim();
        if para.is_empty() {
            continue;
        }
        body.push_str("<p style=\"text-indent:2em\">");
        body.push_str(&html_escape(para));
        body.push_str("</p>\n");
    }
    body
}

pub(crate) fn txt_html(text: &str) -> String {
    let mut body = String::new();
    for para in text.split('\n') {
        let para = para.trim();
        if para.is_empty() {
            continue;
        }
        body.push_str("<p>");
        body.push_str(&html_escape(para));
        body.push_str("</p>\n");
    }
    format!(
        "<!doctype html><html lang=\"zh\"><head><meta charset=\"utf-8\">\
<style>html{{font-size:18px}}body{{font-family:'Microsoft YaHei',serif;line-height:1.85;\
max-width:42em;margin:0 auto;padding:28px 24px;color:#222;background:#fff;}}\
p{{margin:0 0 0.7em;text-indent:2em;}}</style></head><body>{body}</body></html>"
    )
}

pub(crate) fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
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
    fn mobi_split_and_text_html_escape_content() {
        let chapters =
            split_mobi_html("<h1>第一章</h1>A<mbp:pagebreak/><h2>第二章</h2>B<mbp:pagebreak/>C");
        assert_eq!(chapters.len(), 3);
        assert_eq!(chapters[0].0, "第一章");
        assert_eq!(chapters[1].0, "第二章");
        assert!(txt_body("A&B\n<C>").contains("A&amp;B"));
        assert!(txt_html("<危险>").contains("&lt;危险&gt;"));
    }
}
