use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct TocDto {
    pub label: String,
    pub chapter: u32,
    pub frag: String,
    pub level: u8,
}

pub fn flatten_toc(
    navs: &[epub::doc::NavPoint],
    level: u8,
    chapter_map: &HashMap<String, usize>,
    out: &mut Vec<TocDto>,
) {
    for np in navs {
        let (chapter, frag) = toc_target(&np.content, chapter_map);
        out.push(TocDto {
            label: np.label.clone(),
            chapter,
            frag,
            level,
        });
        flatten_toc(&np.children, level + 1, chapter_map, out);
    }
}

/// EPUB3 目录常放在 nav.xhtml 里；epub crate 有些书不会把它转成 doc.toc。
pub fn epub3_nav_toc<R: std::io::Read + std::io::Seek>(
    doc: &mut epub::doc::EpubDoc<R>,
    chapter_map: &HashMap<String, usize>,
) -> Vec<TocDto> {
    let mut nav_paths: Vec<String> = doc
        .resources
        .values()
        .map(|r| r.path.to_string_lossy().replace('\\', "/"))
        .filter(|p| {
            let file = p.rsplit('/').next().unwrap_or(p).to_ascii_lowercase();
            file == "nav.xhtml" || file == "nav.html" || file.contains("nav")
        })
        .collect();
    nav_paths.sort();

    for nav_path in nav_paths {
        let Some(html) = doc.get_resource_str_by_path(&nav_path) else {
            continue;
        };
        let base_dir = nav_path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
        let toc = parse_epub3_nav_html(&html, base_dir, chapter_map);
        if !toc.is_empty() {
            return toc;
        }
    }
    Vec::new()
}

pub fn parse_epub3_nav_html(
    html: &str,
    base_dir: &str,
    chapter_map: &HashMap<String, usize>,
) -> Vec<TocDto> {
    let nav = extract_toc_nav_fragment(html).unwrap_or(html);
    let lower = nav.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut list_depth = 0usize;
    let mut pos = 0usize;

    while let Some(rel_start) = lower[pos..].find('<') {
        let start = pos + rel_start;
        let Some(rel_end) = lower[start..].find('>') else {
            break;
        };
        let end = start + rel_end;
        let tag_lower = &lower[start..=end];
        let tag = &nav[start..=end];

        if tag_lower.starts_with("<ol") || tag_lower.starts_with("<ul") {
            list_depth += 1;
            pos = end + 1;
            continue;
        }
        if tag_lower.starts_with("</ol") || tag_lower.starts_with("</ul") {
            list_depth = list_depth.saturating_sub(1);
            pos = end + 1;
            continue;
        }
        if tag_lower.starts_with("<a") {
            if let Some(href) = html_attr_value(tag, "href") {
                let body_start = end + 1;
                if let Some(rel_close) = lower[body_start..].find("</a>") {
                    let body_end = body_start + rel_close;
                    let label = html_text_content(&nav[body_start..body_end]);
                    if !label.is_empty() {
                        let (chapter, frag) = toc_target_href(&href, base_dir, chapter_map);
                        out.push(TocDto {
                            label,
                            chapter,
                            frag,
                            level: list_depth.saturating_sub(1).min(u8::MAX as usize) as u8,
                        });
                    }
                    pos = body_end + 4;
                    continue;
                }
            }
        }
        pos = end + 1;
    }

    out
}

fn extract_toc_nav_fragment(html: &str) -> Option<&str> {
    let lower = html.to_ascii_lowercase();
    let mut pos = 0usize;
    while let Some(rel_start) = lower[pos..].find("<nav") {
        let start = pos + rel_start;
        let rel_end = lower[start..].find('>')?;
        let tag_end = start + rel_end;
        let tag = &lower[start..=tag_end];
        let is_toc =
            tag.contains("toc") || tag.contains("type=\"toc\"") || tag.contains("type='toc'");
        if is_toc {
            if let Some(rel_close) = lower[tag_end + 1..].find("</nav>") {
                let close = tag_end + 1 + rel_close + "</nav>".len();
                return Some(&html[start..close]);
            }
        }
        pos = tag_end + 1;
    }
    None
}

fn html_attr_value(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let attr_bytes = attr.as_bytes();
    let mut i = 0usize;
    while i + attr_bytes.len() < bytes.len() {
        if !bytes[i..].starts_with(attr_bytes) {
            i += 1;
            continue;
        }
        if i > 0 && is_html_name_byte(bytes[i - 1]) {
            i += 1;
            continue;
        }
        let mut j = i + attr_bytes.len();
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        if j >= bytes.len() || bytes[j] != b'=' {
            i += 1;
            continue;
        }
        j += 1;
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        if j >= bytes.len() {
            return None;
        }
        let original = tag.as_bytes();
        let quote = bytes[j];
        if quote == b'\'' || quote == b'"' {
            j += 1;
            let start = j;
            while j < bytes.len() && bytes[j] != quote {
                j += 1;
            }
            return Some(String::from_utf8_lossy(&original[start..j]).to_string());
        }
        let start = j;
        while j < bytes.len() && !bytes[j].is_ascii_whitespace() && bytes[j] != b'>' {
            j += 1;
        }
        return Some(String::from_utf8_lossy(&original[start..j]).to_string());
    }
    None
}

fn is_html_name_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b':'
}

fn html_text_content(html: &str) -> String {
    let mut text = String::new();
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                text.push(' ');
            }
            _ if !in_tag => text.push(ch),
            _ => {}
        }
    }
    decode_basic_html_entities(&text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn decode_basic_html_entities(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&#160;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn toc_target_href(
    href: &str,
    base_dir: &str,
    chapter_map: &HashMap<String, usize>,
) -> (u32, String) {
    let href = href.trim().replace('\\', "/");
    let (raw_path, frag) = match href.split_once('#') {
        Some((p, f)) => (p, f.to_string()),
        None => (href.as_str(), String::new()),
    };
    let path = raw_path.trim_start_matches("./").trim_start_matches('/');
    if path.is_empty() {
        return (0, frag);
    }
    if let Some(chapter) = chapter_map.get(path) {
        return (*chapter as u32, frag);
    }
    if !base_dir.is_empty() {
        let joined = format!("{base_dir}/{path}");
        if let Some(chapter) = chapter_map.get(&joined) {
            return (*chapter as u32, frag);
        }
    }
    (0, frag)
}

/// 把目录项指向的资源换算成 (章节序号, 章内锚点)。
fn toc_target(content: &Path, chapter_map: &HashMap<String, usize>) -> (u32, String) {
    let s = content.to_string_lossy().replace('\\', "/");
    toc_target_href(&s, "", chapter_map)
}

#[cfg(test)]
mod tests {
    use super::parse_epub3_nav_html;
    use std::collections::HashMap;

    fn map() -> HashMap<String, usize> {
        HashMap::from([
            ("OPS/chapter1.xhtml".to_string(), 0),
            ("OPS/chapter2.xhtml".to_string(), 1),
            ("OPS/appendix.xhtml".to_string(), 2),
        ])
    }

    #[test]
    fn parses_epub3_toc_nav_and_nested_levels() {
        let html = r#"
          <html><body>
            <nav epub:type="landmarks"><ol><li><a href="cover.xhtml">Cover</a></li></ol></nav>
            <nav epub:type="toc"><ol>
              <li><a href="chapter1.xhtml#p1">第一章 &amp; 开端</a>
                <ol><li><a href="chapter2.xhtml">第二章</a></li></ol>
              </li>
            </ol></nav>
          </body></html>
        "#;
        let toc = parse_epub3_nav_html(html, "OPS", &map());
        assert_eq!(toc.len(), 2);
        assert_eq!(toc[0].label, "第一章 & 开端");
        assert_eq!(toc[0].chapter, 0);
        assert_eq!(toc[0].frag, "p1");
        assert_eq!(toc[0].level, 0);
        assert_eq!(toc[1].label, "第二章");
        assert_eq!(toc[1].chapter, 1);
        assert_eq!(toc[1].level, 1);
    }

    #[test]
    fn parses_nav_without_quotes_and_strips_inline_tags() {
        let html = r#"<nav role=toc><ol><li><a href=appendix.xhtml><span>附录</span>&nbsp;A</a></li></ol></nav>"#;
        let toc = parse_epub3_nav_html(html, "OPS", &map());
        assert_eq!(toc.len(), 1);
        assert_eq!(toc[0].label, "附录 A");
        assert_eq!(toc[0].chapter, 2);
    }

    #[test]
    fn falls_back_to_whole_html_when_toc_nav_is_missing() {
        let html = r#"<ol><li><a href="chapter2.xhtml#frag">第二章</a></li></ol>"#;
        let toc = parse_epub3_nav_html(html, "OPS", &map());
        assert_eq!(toc.len(), 1);
        assert_eq!(toc[0].chapter, 1);
        assert_eq!(toc[0].frag, "frag");
    }
}
