use crate::url_open;
use serde_json::Value;

pub(super) fn absolute_image_url(page_url: &str, value: &str) -> String {
    let decoded = value
        .trim()
        .replace("&amp;", "&")
        .replace("&#x26;", "&")
        .replace("&#X26;", "&")
        .replace("&#38;", "&");
    let value = decoded.trim();
    if let Ok(url) = url_open::validate_https_url(value) {
        return url.to_string();
    }
    let Some(rest) = page_url.strip_prefix("https://") else {
        return String::new();
    };
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let origin = format!("https://{}", &rest[..authority_end]);
    let candidate = if let Some(value) = value.strip_prefix("//") {
        format!("https://{value}")
    } else if value.starts_with('/') {
        format!("{origin}{value}")
    } else {
        return String::new();
    };
    url_open::validate_https_url(&candidate)
        .map(str::to_string)
        .unwrap_or_default()
}

pub(super) fn preview_image_from_html(html: &str, page_url: &str) -> String {
    // 这些站点的通用首图经常是导航 Logo。仅使用它们已确认的正文结构；
    // 找不到真实正文图就明确无图，不再猜测。
    if page_url.contains("thepaper.cn/") {
        return thepaper_preview_image_from_html(html, page_url);
    }
    if page_url.contains("coolapk.com/") {
        return image_from_tag_with_class(html, page_url, "message-image");
    }
    if is_juejin_article_url(page_url) {
        return juejin_preview_image_from_html(html, page_url);
    }
    if page_url.contains("bbs.hupu.com/") {
        return hupu_preview_image_from_html(html, page_url);
    }
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(found) = lower[cursor..].find("<meta") {
        let start = cursor + found;
        let Some(end) = html[start..].find('>').map(|offset| start + offset + 1) else {
            break;
        };
        let tag = &html[start..end];
        let kind = html_attribute(tag, "property")
            .or_else(|| html_attribute(tag, "name"))
            .or_else(|| html_attribute(tag, "itemprop"));
        if kind.is_some_and(|kind| {
            matches!(
                kind.to_ascii_lowercase().as_str(),
                "og:image" | "twitter:image" | "twitter:image:src" | "image"
            )
        }) {
            if let Some(content) = html_attribute(tag, "content") {
                let image = absolute_image_url(page_url, &content);
                if !image.is_empty() {
                    return image;
                }
            }
        }
        cursor = end;
    }
    first_non_chrome_image(html, page_url)
}

pub(super) fn html_text(value: &str) -> String {
    // RSS/Atom descriptions frequently escape their embedded markup, for
    // example `&lt;a href="…"&gt;`. Decode first so that the tag is removed rather
    // than being restored as visible text after the stripping pass.
    let value = decode_html_entities(value);
    let mut text = String::with_capacity(value.len());
    let mut in_tag = false;
    let mut characters = value.chars();
    while let Some(character) = characters.next() {
        match character {
            '<' if !in_tag && starts_html_tag(characters.as_str()) => in_tag = true,
            '<' if !in_tag => text.push(character),
            '>' if in_tag => in_tag = false,
            _ if !in_tag => text.push(character),
            _ => {}
        }
    }

    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn decode_html_entities(value: &str) -> String {
    value
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn starts_html_tag(value: &str) -> bool {
    let Some(end) = value.find('>') else {
        return false;
    };
    let value = &value[..end];
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if matches!(first, '!' | '?') {
        return true;
    }
    let mut tag_name_started = first.is_ascii_alphabetic();
    if first == '/' {
        tag_name_started = characters
            .next()
            .is_some_and(|character| character.is_ascii_alphabetic());
    }
    if !tag_name_started {
        return false;
    }
    let remainder = characters.as_str();
    let name_end = remainder
        .find(|character: char| !character.is_ascii_alphanumeric() && character != '-')
        .unwrap_or(remainder.len());
    remainder[name_end..]
        .chars()
        .next()
        .is_none_or(|character| character.is_ascii_whitespace() || character == '/')
}

pub(super) fn element_with_class<'a>(
    html: &'a str,
    tag: &str,
    class: &str,
) -> Option<(&'a str, &'a str)> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(start) = tag_start(&lower, tag, cursor) {
        let end = tag_end(html, start)?;
        let opening = &html[start..end];
        if class.is_empty() || class_contains(opening, class) {
            let close = format!("</{tag}>");
            let content_end = lower[end..].find(&close).map(|offset| end + offset)?;
            return Some((opening, &html[end..content_end]));
        }
        cursor = end;
    }
    None
}

pub(super) fn balanced_element_with_class<'a>(
    html: &'a str,
    tag: &str,
    class: &str,
) -> Option<(&'a str, &'a str)> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(start) = tag_start(&lower, tag, cursor) {
        let opening_end = tag_end(html, start)?;
        let opening = &html[start..opening_end];
        if !class_contains(opening, class) {
            cursor = opening_end;
            continue;
        }
        let closing = format!("</{tag}>");
        let mut depth = 1usize;
        let mut scan = opening_end;
        while depth > 0 {
            let next_open = tag_start(&lower, tag, scan);
            let next_close = lower[scan..].find(&closing).map(|offset| scan + offset);
            match (next_open, next_close) {
                (_, Some(close)) if next_open.is_none_or(|open| close < open) => {
                    depth -= 1;
                    if depth == 0 {
                        return Some((opening, &html[opening_end..close]));
                    }
                    scan = close + closing.len();
                }
                (Some(open), _) => {
                    depth += 1;
                    scan = tag_end(html, open)?;
                }
                _ => return None,
            }
        }
    }
    None
}

pub(super) fn tag_with_class<'a>(html: &'a str, tag: &str, class: &str) -> Option<&'a str> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(start) = tag_start(&lower, tag, cursor) {
        let end = tag_end(html, start)?;
        let opening = &html[start..end];
        if class.is_empty() || class_contains(opening, class) {
            return Some(opening);
        }
        cursor = end;
    }
    None
}

pub(super) fn list_item_blocks(html: &str) -> Vec<&str> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    let mut blocks = Vec::new();
    while let Some(start) = tag_start(&lower, "li", cursor) {
        let Some(end) = lower[start..]
            .find("</li>")
            .map(|offset| start + offset + 5)
        else {
            break;
        };
        blocks.push(&html[start..end]);
        cursor = end;
    }
    blocks
}

pub(super) fn section_from_marker<'a>(
    html: &'a str,
    marker: &str,
    before_marker: bool,
) -> Option<&'a str> {
    let lower = html.to_ascii_lowercase();
    let marker = marker.to_ascii_lowercase();
    let marker_start = lower.find(&marker)?;
    let list_start = if before_marker {
        lower[..marker_start].rfind("<ul")?
    } else {
        marker_start + lower[marker_start..].find("<ul")?
    };
    let list_end = lower[list_start..]
        .find("</ul>")
        .map(|offset| list_start + offset + 5)?;
    Some(&html[list_start..list_end])
}

pub(super) fn html_attribute(tag: &str, attribute: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(found) = lower[cursor..].find(attribute) {
        let start = cursor + found;
        let before = lower.as_bytes().get(start.wrapping_sub(1)).copied();
        let after = lower.as_bytes().get(start + attribute.len()).copied();
        if before.is_none_or(|ch| ch.is_ascii_whitespace() || ch == b'<')
            && after.is_some_and(|ch| ch.is_ascii_whitespace() || ch == b'=')
        {
            let mut value_start = start + attribute.len();
            while lower
                .as_bytes()
                .get(value_start)
                .is_some_and(u8::is_ascii_whitespace)
            {
                value_start += 1;
            }
            if lower.as_bytes().get(value_start) != Some(&b'=') {
                cursor = value_start;
                continue;
            }
            value_start += 1;
            while lower
                .as_bytes()
                .get(value_start)
                .is_some_and(u8::is_ascii_whitespace)
            {
                value_start += 1;
            }
            let quote = *tag.as_bytes().get(value_start)?;
            if quote != b'\'' && quote != b'"' {
                return None;
            }
            let value_start = value_start + 1;
            let end = tag[value_start..].find(quote as char)? + value_start;
            return Some(tag[value_start..end].trim().to_string());
        }
        cursor = start + attribute.len();
    }
    None
}

fn is_site_chrome_image(tag: &str, value: &str) -> bool {
    let tag = tag.to_ascii_lowercase();
    let value = value.to_ascii_lowercase();
    ["logo", "favicon", "avatar", "qrcode", "qr-code"]
        .iter()
        .any(|marker| tag.contains(marker) || value.contains(marker))
}

fn image_from_tag_with_class(html: &str, page_url: &str, class: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let class = class.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(found) = lower[cursor..].find("<img") {
        let start = cursor + found;
        let Some(end) = html[start..].find('>').map(|offset| start + offset + 1) else {
            break;
        };
        let tag = &html[start..end];
        if html_attribute(tag, "class")
            .is_some_and(|value| value.to_ascii_lowercase().contains(&class))
        {
            for attribute in ["data-src", "data-original", "data-lazy-src", "src"] {
                if let Some(value) = html_attribute(tag, attribute) {
                    let image = absolute_image_url(page_url, &value);
                    if !image.is_empty() {
                        return image;
                    }
                }
            }
        }
        cursor = end;
    }
    String::new()
}

fn json_script_by_id(html: &str, id: &str) -> Option<Value> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(found) = lower[cursor..].find("<script") {
        let start = cursor + found;
        let tag_end = html[start..].find('>').map(|offset| start + offset + 1)?;
        let tag = &html[start..tag_end];
        if html_attribute(tag, "id").is_some_and(|value| value.eq_ignore_ascii_case(id)) {
            let content_end = lower[tag_end..]
                .find("</script>")
                .map(|offset| tag_end + offset)?;
            return serde_json::from_str(&html[tag_end..content_end]).ok();
        }
        cursor = tag_end;
    }
    None
}

fn thepaper_preview_image_from_html(html: &str, page_url: &str) -> String {
    let from_data = json_script_by_id(html, "__NEXT_DATA__")
        .and_then(|data| {
            [
                "/props/pageProps/detailData/contentDetail/sharePic",
                "/props/pageProps/detailData/contentDetail/pic",
                "/props/pageProps/detailData/contentDetail/voiceInfo/imgSrc",
            ]
            .into_iter()
            .filter_map(|pointer| data.pointer(pointer).and_then(Value::as_str))
            .map(https_url)
            .find(|image| !image.is_empty())
        })
        .unwrap_or_default();
    if !from_data.is_empty() {
        return from_data;
    }
    image_from_tag_with_class(html, page_url, "img_default")
}

fn https_url(value: &str) -> String {
    url_open::validate_https_url(value)
        .map(str::to_string)
        .unwrap_or_default()
}

fn javascript_string_property(html: &str, property: &str) -> Option<String> {
    let marker = format!("{property}:\"");
    let value = html.split_once(&marker)?.1;
    let mut chars = value.chars();
    let mut output = String::new();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => return Some(output),
            '\\' => match chars.next()? {
                '"' => output.push('"'),
                '\\' => output.push('\\'),
                '/' => output.push('/'),
                'b' => output.push('\u{0008}'),
                'f' => output.push('\u{000c}'),
                'n' => output.push('\n'),
                'r' => output.push('\r'),
                't' => output.push('\t'),
                'u' => {
                    let digits = chars.by_ref().take(4).collect::<String>();
                    if digits.len() != 4 {
                        return None;
                    }
                    if let Some(decoded) = u32::from_str_radix(&digits, 16)
                        .ok()
                        .and_then(char::from_u32)
                    {
                        output.push(decoded);
                    }
                }
                escaped => output.push(escaped),
            },
            _ => output.push(ch),
        }
    }
    None
}

pub(super) fn first_non_chrome_image(html: &str, page_url: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(found) = lower[cursor..].find("<img") {
        let start = cursor + found;
        let Some(end) = html[start..].find('>').map(|offset| start + offset + 1) else {
            break;
        };
        let tag = &html[start..end];
        for attribute in ["data-src", "data-original", "data-lazy-src", "src"] {
            if let Some(value) = html_attribute(tag, attribute) {
                if is_site_chrome_image(tag, &value) {
                    continue;
                }
                let image = absolute_image_url(page_url, &value);
                if !image.is_empty() {
                    return image;
                }
            }
        }
        cursor = end;
    }
    String::new()
}

fn juejin_preview_image_from_html(html: &str, page_url: &str) -> String {
    javascript_string_property(html, "web_html_content")
        .map(|content| first_non_chrome_image(&content, page_url))
        .unwrap_or_default()
}

fn hupu_preview_image_from_html(html: &str, page_url: &str) -> String {
    // 虎扑热帖接口只给帖子地址，未附封面。页面顶端则包含站点 Logo、
    // 用户头像和广告图；若使用通用首图扫描，很容易把头像当成卡片封面。
    // 只从楼主正文容器取图，找不到正文图时明确保持无图。
    element_with_class(html, "div", "thread-content-detail")
        .map(|(_, content)| first_non_chrome_image(content, page_url))
        .unwrap_or_default()
}

fn is_juejin_article_url(url: &str) -> bool {
    tauri::Url::parse(url).ok().is_some_and(|url| {
        matches!(url.host_str(), Some("juejin.cn" | "www.juejin.cn"))
            && url.path().starts_with("/post/")
    })
}

fn class_contains(tag: &str, expected: &str) -> bool {
    html_attribute(tag, "class").is_some_and(|classes| {
        classes
            .split_ascii_whitespace()
            .any(|class| class.eq_ignore_ascii_case(expected))
    })
}

fn tag_end(html: &str, start: usize) -> Option<usize> {
    html[start..].find('>').map(|offset| start + offset + 1)
}

fn tag_start(lower: &str, tag: &str, cursor: usize) -> Option<usize> {
    let needle = format!("<{tag}");
    let mut cursor = cursor;
    while let Some(found) = lower[cursor..].find(&needle) {
        let start = cursor + found;
        if lower
            .as_bytes()
            .get(start + needle.len())
            .is_some_and(|byte| byte.is_ascii_whitespace() || *byte == b'>' || *byte == b'/')
        {
            return Some(start);
        }
        cursor = start + needle.len();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_only_absolute_or_root_relative_https_image_urls() {
        assert_eq!(
            absolute_image_url("https://news.example/path/story", "/cover.jpg?x=1&amp;y=2"),
            "https://news.example/cover.jpg?x=1&y=2"
        );
        assert_eq!(
            absolute_image_url("https://news.example/path/story", "//cdn.example/cover.jpg"),
            "https://cdn.example/cover.jpg"
        );
        assert!(absolute_image_url("https://news.example/path/story", "cover.jpg").is_empty());
        let insecure = ["ht", "tp://example.com/cover.jpg"].concat();
        assert!(absolute_image_url("https://news.example/path/story", &insecure).is_empty());
    }

    #[test]
    fn exact_class_matching_and_balanced_content_ignore_neighboring_elements() {
        assert!(element_with_class(
            r#"<div class="article content">ok</div><div class="article-content">wrong</div>"#,
            "div",
            "content"
        )
        .is_some());
        assert!(element_with_class(
            r#"<div class="article-content">wrong</div>"#,
            "div",
            "content"
        )
        .is_none());
        let (_, content) = balanced_element_with_class(
            r#"<div class="body"><div><p>nested</p></div><p>tail</p></div>"#,
            "div",
            "body",
        )
        .expect("target element should be found");
        assert_eq!(content, "<div><p>nested</p></div><p>tail</p>");
    }

    #[test]
    fn preview_extraction_prefers_metadata_and_ignores_site_chrome_images() {
        assert_eq!(
            preview_image_from_html(
                r#"<meta property="og:image" content="/cover.jpg"><img class="site-logo" src="/logo.png">"#,
                "https://news.example/path/story"
            ),
            "https://news.example/cover.jpg"
        );
        assert_eq!(
            preview_image_from_html(
                r#"<img class="site-logo" src="/logo.png"><img data-src="/body.jpg">"#,
                "https://news.example/path/story"
            ),
            "https://news.example/body.jpg"
        );
    }

    #[test]
    fn html_text_removes_escaped_anchor_markup_without_hiding_plain_angle_text() {
        assert_eq!(
            html_text(
                r#"Read &lt;a href="https://news.example/article/very-long-id"&gt;the report&lt;/a&gt; &amp; act."#
            ),
            "Read the report & act."
        );
        assert_eq!(
            html_text("A value < 3 remains text."),
            "A value < 3 remains text."
        );
    }
}
