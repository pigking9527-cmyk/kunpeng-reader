pub fn sanitize_mobi_html(html: &str) -> String {
    strip_unsafe_html_attrs(&strip_dangerous_html_blocks(html))
}

fn is_html_open_tag(lower_rest: &str, tag: &str) -> bool {
    if !lower_rest.starts_with('<') {
        return false;
    }
    let after = 1 + tag.len();
    lower_rest.starts_with(&format!("<{tag}"))
        && lower_rest
            .as_bytes()
            .get(after)
            .map(|b| b.is_ascii_whitespace() || *b == b'>' || *b == b'/')
            .unwrap_or(true)
}

fn strip_dangerous_html_blocks(html: &str) -> String {
    const BLOCK_TAGS: [&str; 8] = [
        "script", "iframe", "object", "embed", "form", "button", "textarea", "select",
    ];
    const VOID_TAGS: [&str; 5] = ["input", "meta", "link", "base", "frame"];
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    'outer: while i < html.len() {
        if html.as_bytes()[i] == b'<' {
            let rest = &lower[i..];
            for tag in BLOCK_TAGS {
                if is_html_open_tag(rest, tag) {
                    let close = format!("</{tag}");
                    if let Some(close_start) = lower[i..].find(&close) {
                        let close_abs = i + close_start;
                        if let Some(close_end) = lower[close_abs..].find('>') {
                            i = close_abs + close_end + 1;
                            continue 'outer;
                        }
                    }
                    if let Some(gt) = html[i..].find('>') {
                        i += gt + 1;
                        continue 'outer;
                    }
                    break;
                }
            }
            for tag in VOID_TAGS {
                if is_html_open_tag(rest, tag) {
                    if let Some(gt) = html[i..].find('>') {
                        i += gt + 1;
                        continue 'outer;
                    }
                    break;
                }
            }
        }
        let ch = html[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn html_attr_escape(s: &str) -> String {
    html_escape(s).replace('"', "&quot;")
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn is_unsafe_html_attr(name: &str, value: Option<&str>) -> bool {
    let lname = name.trim().to_ascii_lowercase();
    if lname.is_empty() || lname == "srcdoc" || lname.starts_with("on") {
        return true;
    }
    let Some(value) = value else {
        return false;
    };
    let v = value
        .trim_start_matches(|c: char| c.is_ascii_whitespace() || c.is_control())
        .to_ascii_lowercase();
    if matches!(
        lname.as_str(),
        "href" | "src" | "xlink:href" | "poster" | "action" | "formaction"
    ) && (v.starts_with("javascript:")
        || v.starts_with("vbscript:")
        || v.starts_with("data:text/html")
        || v.starts_with("data:application/xhtml"))
    {
        return true;
    }
    lname == "style"
        && (v.contains("javascript:") || v.contains("vbscript:") || v.contains("expression("))
}

fn sanitize_html_tag(tag: &str) -> String {
    if tag.len() < 3 || !tag.starts_with('<') || !tag.ends_with('>') {
        return tag.to_string();
    }
    let inner = &tag[1..tag.len() - 1];
    let trimmed = inner.trim_start();
    if trimmed.starts_with('/') || trimmed.starts_with('!') || trimmed.starts_with('?') {
        return tag.to_string();
    }
    let bytes = inner.as_bytes();
    let mut pos = 0;
    while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
        pos += 1;
    }
    let name_start = pos;
    while pos < bytes.len() && !bytes[pos].is_ascii_whitespace() && bytes[pos] != b'/' {
        pos += 1;
    }
    if name_start == pos {
        return String::new();
    }
    let mut out = String::from("<");
    out.push_str(&inner[name_start..pos]);
    let mut self_close = false;
    while pos < bytes.len() {
        while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
            pos += 1;
        }
        if pos >= bytes.len() {
            break;
        }
        if bytes[pos] == b'/' {
            self_close = true;
            pos += 1;
            continue;
        }
        let attr_start = pos;
        while pos < bytes.len()
            && !bytes[pos].is_ascii_whitespace()
            && bytes[pos] != b'='
            && bytes[pos] != b'/'
        {
            pos += 1;
        }
        let attr_name = inner[attr_start..pos].trim();
        while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
            pos += 1;
        }
        let mut attr_value: Option<&str> = None;
        if pos < bytes.len() && bytes[pos] == b'=' {
            pos += 1;
            while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
                pos += 1;
            }
            if pos < bytes.len() && (bytes[pos] == b'"' || bytes[pos] == b'\'') {
                let quote = bytes[pos];
                pos += 1;
                let value_start = pos;
                while pos < bytes.len() && bytes[pos] != quote {
                    pos += 1;
                }
                attr_value = Some(&inner[value_start..pos]);
                if pos < bytes.len() {
                    pos += 1;
                }
            } else {
                let value_start = pos;
                while pos < bytes.len() && !bytes[pos].is_ascii_whitespace() && bytes[pos] != b'/' {
                    pos += 1;
                }
                attr_value = Some(&inner[value_start..pos]);
            }
        }
        if !is_unsafe_html_attr(attr_name, attr_value) {
            out.push(' ');
            out.push_str(attr_name);
            if let Some(v) = attr_value {
                out.push_str("=\"");
                out.push_str(&html_attr_escape(v));
                out.push('"');
            }
        }
    }
    if self_close {
        out.push_str(" /");
    }
    out.push('>');
    out
}

fn strip_unsafe_html_attrs(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    while i < html.len() {
        if html.as_bytes()[i] == b'<' {
            if let Some(gt) = html[i..].find('>') {
                let end = i + gt + 1;
                out.push_str(&sanitize_html_tag(&html[i..end]));
                i = end;
                continue;
            }
        }
        let ch = html[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::sanitize_mobi_html;

    #[test]
    fn removes_script_blocks_and_dangerous_elements() {
        let html = r#"<p>ok</p><script>alert(1)</script><iframe src="x"></iframe><p>tail</p>"#;
        assert_eq!(sanitize_mobi_html(html), "<p>ok</p><p>tail</p>");
    }

    #[test]
    fn removes_event_handlers_and_javascript_urls() {
        let html = r#"<a href="javascript:alert(1)" onclick="x()" title="keep">word</a>"#;
        assert_eq!(sanitize_mobi_html(html), r#"<a title="keep">word</a>"#);
    }

    #[test]
    fn escapes_kept_attribute_values() {
        let html = r#"<img alt="a < b & c &quot;quoted&quot;" src="cover.jpg">"#;
        assert_eq!(
            sanitize_mobi_html(html),
            r#"<img alt="a &lt; b &amp; c &amp;quot;quoted&amp;quot;" src="cover.jpg">"#
        );
    }

    #[test]
    fn strips_srcdoc_and_style_script_expressions() {
        let html = r#"<div srcdoc="<script>x</script>" style="background:expression(alert(1))" class="note">x</div>"#;
        assert_eq!(sanitize_mobi_html(html), r#"<div class="note">x</div>"#);
    }
}
