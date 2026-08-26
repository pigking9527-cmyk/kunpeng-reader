use crate::text_chapters::{build_md_chapters, build_txt_chapters, is_txt_heading};
use crate::{book, AppState};
use std::sync::Arc;

mod html_resources;

pub(crate) use html_resources::{
    collect_head_assets, collect_local_stylesheet_links, collect_local_stylesheet_paths,
    extract_body_inner, guess_mime, inline_local_stylesheet_links, percent_decode, rewrite_attrs,
    rewrite_css_url,
};

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
        let mut cache = state.txt_chapters.lock().unwrap();
        if let Some(chapters) = cache.get(id) {
            return Some(chapters);
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
    let (book_limit, byte_limit) = state.epub_runtime.text_chapter_cache_limits();
    state
        .txt_chapters
        .lock()
        .unwrap()
        .insert(id, Arc::clone(&arc), book_limit, byte_limit);
    Some(arc)
}

#[derive(Debug, PartialEq, Eq)]
enum TxtRenderBlock {
    Paragraph(String),
    Verse(Vec<String>),
}

fn is_verse_cue(line: &str) -> bool {
    verse_cue_start(line).is_some()
}

fn verse_cue_start(line: &str) -> Option<usize> {
    ["诗曰", "詩曰", "词曰", "詞曰", "赋曰", "賦曰", "偈曰"]
        .iter()
        .filter_map(|cue| line.find(cue))
        .min()
}

fn is_sentence_end(line: &str) -> bool {
    let mut chars = line.trim().chars().rev();
    let Some(mut last) = chars.next() else {
        return false;
    };
    if matches!(last, '”' | '’' | '」' | '』' | '》' | '〉' | '）' | '】') {
        last = chars.next().unwrap_or(last);
    }
    matches!(last, '。' | '！' | '？' | '…')
}

/// 判断 TXT 是否存在下载站常见的固定列宽软换行。
///
/// 普通网文通常每行就是一个完整段落，不能因为存在换行而一律合并。只有大量
/// 长度集中、并且显然还没结束一句话的连续文本行才视为下载时插入的软换行。
fn has_fixed_width_soft_wrap(text: &str) -> bool {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| {
            let len = line.chars().count();
            !line.is_empty()
                && !is_txt_heading(line)
                && !is_verse_cue(line)
                && (16..=120).contains(&len)
        })
        .collect();
    if lines.len() < 12 {
        return false;
    }

    let mut lengths = [0usize; 121];
    for line in &lines {
        lengths[line.chars().count()] += 1;
    }
    let (mode, mode_count) = lengths
        .iter()
        .enumerate()
        .max_by_key(|(_, count)| *count)
        .map(|(length, count)| (length, *count))
        .unwrap_or((0, 0));
    if mode < 24 || mode_count < 4 {
        return false;
    }

    let near_mode: Vec<&str> = lines
        .into_iter()
        .filter(|line| line.chars().count().abs_diff(mode) <= 2)
        .collect();
    let unfinished = near_mode
        .iter()
        .filter(|line| !is_sentence_end(line))
        .count();
    near_mode.len() * 100 >= 55 * lengths.iter().sum::<usize>()
        && unfinished >= 4
        && unfinished * 100 >= 35 * near_mode.len()
}

fn is_short_verse_block(lines: &[String]) -> bool {
    lines.len() >= 3
        && lines.iter().all(|line| line.chars().count() <= 28)
        && lines.iter().filter(|line| is_sentence_end(line)).count() >= 2
}

/// 某些 TXT 的换行只在个别段落中出现，整本统计未必足以判定。这里再按段落
/// 识别连续的长未完句，避免把“祖脉，三\n岛之来龙”拆成两个缩进段落。
fn has_local_soft_wrap(lines: &[String]) -> bool {
    let unfinished: Vec<usize> = lines
        .iter()
        .map(|line| line.chars().count())
        .filter(|len| (16..=120).contains(len))
        .collect();
    if unfinished.len() < 3 {
        return false;
    }
    let long_unfinished = lines
        .iter()
        .filter(|line| {
            let len = line.chars().count();
            (16..=120).contains(&len) && !is_sentence_end(line)
        })
        .count();
    let min_len = *unfinished.iter().min().unwrap_or(&0);
    let max_len = *unfinished.iter().max().unwrap_or(&0);
    long_unfinished >= 2 && max_len.saturating_sub(min_len) <= 12
}

fn flush_txt_block(
    lines: &mut Vec<String>,
    blocks: &mut Vec<TxtRenderBlock>,
    unwrap_soft_wraps: bool,
) {
    if lines.is_empty() {
        return;
    }
    if let Some((line_index, cue_index)) =
        lines.iter().enumerate().find_map(|(line_index, line)| {
            verse_cue_start(line)
                .filter(|cue_index| *cue_index > 0)
                .map(|cue_index| (line_index, cue_index))
        })
    {
        let mut prose = lines[..line_index].to_vec();
        let cue_line = &lines[line_index];
        let before_cue = cue_line[..cue_index].trim_end();
        if !before_cue.is_empty() {
            prose.push(before_cue.to_string());
        }
        let mut verse = vec![cue_line[cue_index..].to_string()];
        verse.extend(lines[line_index + 1..].iter().cloned());
        lines.clear();
        flush_txt_block(&mut prose, blocks, unwrap_soft_wraps);
        flush_txt_block(&mut verse, blocks, unwrap_soft_wraps);
    } else if unwrap_soft_wraps && is_short_verse_block(lines) {
        blocks.push(TxtRenderBlock::Verse(std::mem::take(lines)));
    } else if unwrap_soft_wraps || has_local_soft_wrap(lines) {
        blocks.push(TxtRenderBlock::Paragraph(lines.drain(..).collect()));
    } else {
        blocks.extend(lines.drain(..).map(TxtRenderBlock::Paragraph));
    }
}

fn txt_render_blocks(text: &str) -> Vec<TxtRenderBlock> {
    let unwrap_soft_wraps = has_fixed_width_soft_wrap(text);
    let mut blocks = Vec::new();
    let mut current = Vec::new();
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            flush_txt_block(&mut current, &mut blocks, unwrap_soft_wraps);
        } else if is_txt_heading(line) {
            flush_txt_block(&mut current, &mut blocks, unwrap_soft_wraps);
            blocks.push(TxtRenderBlock::Paragraph(line.to_string()));
        } else {
            current.push(line.to_string());
        }
    }
    flush_txt_block(&mut current, &mut blocks, unwrap_soft_wraps);
    blocks
}

/// 把纯文本段落化为合并阅读页用的正文 HTML。
///
/// 自动合并下载站导出的固定宽度软换行，但不改动源文件，也保留空行、章节标题和诗词。
pub(crate) fn txt_body(text: &str) -> String {
    let mut body = String::new();
    for block in txt_render_blocks(text) {
        match block {
            TxtRenderBlock::Paragraph(para) => {
                body.push_str("<p style=\"text-indent:2em\">");
                body.push_str(&html_escape(&para));
                body.push_str("</p>\n");
            }
            TxtRenderBlock::Verse(lines) => {
                body.push_str("<p class=\"txt-verse\" style=\"text-indent:0\">");
                for (index, line) in lines.iter().enumerate() {
                    if index > 0 {
                        body.push_str("<br>");
                    }
                    body.push_str(&html_escape(line));
                }
                body.push_str("</p>\n");
            }
        }
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
    fn mobi_split_and_text_html_escape_content() {
        let chapters =
            split_mobi_html("<h1>第一章</h1>A<mbp:pagebreak/><h2>第二章</h2>B<mbp:pagebreak/>C");
        assert_eq!(chapters.len(), 3);
        assert_eq!(chapters[0].0, "第一章");
        assert_eq!(chapters[1].0, "第二章");
        assert!(txt_body("A&B\n<C>").contains("A&amp;B"));
        assert!(txt_html("<危险>").contains("&lt;危险&gt;"));
    }

    #[test]
    fn txt_body_automatically_joins_fixed_width_soft_wraps() {
        let wrapped = (0..12)
            .map(|_| "天地玄黄宇宙洪荒".repeat(4))
            .collect::<Vec<_>>()
            .join("\n");
        let text = format!(
            "第一回 自动换行\n\n{wrapped}\n\n诗曰：\n春风吹绿江南岸。\n明月何时照我还。\n山高水长人未远。"
        );

        let blocks = txt_render_blocks(&text);
        assert_eq!(blocks.len(), 3);
        assert_eq!(
            blocks[1],
            TxtRenderBlock::Paragraph(wrapped.replace('\n', ""))
        );
        assert!(matches!(&blocks[2], TxtRenderBlock::Verse(lines) if lines.len() == 4));

        let html = txt_body(&text);
        assert_eq!(html.matches("天地玄黄宇宙洪荒</p>").count(), 1);
        assert!(html.contains("class=\"txt-verse\""));
    }

    #[test]
    fn txt_body_keeps_regular_one_line_paragraphs() {
        let blocks = txt_render_blocks("第一段。\n第二段。\n第三段。");
        assert_eq!(
            blocks,
            vec![
                TxtRenderBlock::Paragraph("第一段。".to_string()),
                TxtRenderBlock::Paragraph("第二段。".to_string()),
                TxtRenderBlock::Paragraph("第三段。".to_string()),
            ]
        );
    }

    #[test]
    fn inline_verse_cue_does_not_keep_the_preceding_prose_hard_wrapped() {
        let mut lines = vec![
            "此山乃十洲之祖脉，三".to_string(),
            "岛之来龙，自开清浊而立。有词赋为证。赋曰：势镇".to_string(),
            "汪洋，威宁瑶海。".to_string(),
        ];
        let mut blocks = Vec::new();
        flush_txt_block(&mut lines, &mut blocks, true);

        assert_eq!(
            blocks[0],
            TxtRenderBlock::Paragraph(
                "此山乃十洲之祖脉，三岛之来龙，自开清浊而立。有词赋为证。".to_string()
            )
        );
        assert_eq!(
            blocks[1],
            TxtRenderBlock::Paragraph("赋曰：势镇汪洋，威宁瑶海。".to_string())
        );
    }

    #[test]
    fn local_fixed_width_prose_before_traditional_verse_cue_is_joined() {
        let fixed_width_prefix = (0..12)
            .map(|_| "天地玄黃宇宙洪荒".repeat(4))
            .collect::<Vec<_>>()
            .join("\n");
        let text = format!(
            "{fixed_width_prefix}\n\n感盤古開闢，三皇治世，五帝定倫，世界之間，遂分為四大部洲：曰東勝神洲，\n曰西牛賀洲，曰南贍部洲，曰北俱蘆洲。這部書單表東勝神洲。海外有一國土，\n名曰傲來國。國近大海，海中有一座名山，喚為花果山。此山乃十洲之祖脈，三\n島之來龍，自開清濁而立，鴻濛判後而成。真個好山！有詞賦為證。賦曰：勢鎮\n汪洋，威寧瑤海。"
        );

        let html = txt_body(&text);
        assert!(html.contains("十洲之祖脈，三島之來龍，自開清濁"));
        assert!(!html.contains("十洲之祖脈，三</p>"));
        assert!(html.contains("賦曰：勢鎮汪洋，威寧瑤海。"));
        assert!(!html.contains("賦曰：勢鎮</p>"));
    }
}
