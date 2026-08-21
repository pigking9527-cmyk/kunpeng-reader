/// 一行是否像章节标题（中文网文："第X章/节/回 …"，或独立的"楔子/序章/番外"等短行）。
pub fn is_txt_heading(line: &str) -> bool {
    let t = line.trim();
    let cc = t.chars().count();
    if cc == 0 || cc > 40 {
        return false;
    }
    let head: String = t.chars().take(14).collect();
    if t.starts_with('第') && (head.contains('章') || head.contains('节') || head.contains('回'))
    {
        return true;
    }
    matches!(
        t,
        "楔子" | "序" | "序章" | "序言" | "前言" | "引子" | "后记" | "尾声" | "番外"
    )
}

fn txt_chapter_is_heading_only(text: &str) -> bool {
    let mut non_empty = text.lines().map(str::trim).filter(|line| !line.is_empty());
    let first = match non_empty.next() {
        Some(line) => line,
        None => return false,
    };
    non_empty.next().is_none() && is_txt_heading(first)
}

fn first_non_empty_line(text: &str) -> Option<&str> {
    text.lines().map(str::trim).find(|line| !line.is_empty())
}

fn merge_title_only_txt_chapters(chapters: Vec<(String, String)>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::with_capacity(chapters.len());
    let mut pending: Option<(String, String)> = None;

    for (title, body) in chapters {
        if txt_chapter_is_heading_only(&body) {
            pending = Some(match pending.take() {
                Some((pending_title, mut pending_body)) => {
                    if !pending_body.ends_with('\n') {
                        pending_body.push('\n');
                    }
                    pending_body.push_str(&body);
                    (pending_title, pending_body)
                }
                None => (title, body),
            });
            continue;
        }

        if let Some((pending_title, mut pending_body)) = pending.take() {
            let pending_line = first_non_empty_line(&pending_body).unwrap_or("");
            let body_line = first_non_empty_line(&body).unwrap_or("");
            if pending_line == body_line {
                out.push((pending_title, body));
            } else {
                if !pending_body.ends_with('\n') {
                    pending_body.push('\n');
                }
                pending_body.push_str(&body);
                out.push((pending_title, pending_body));
            }
        } else {
            out.push((title, body));
        }
    }

    if let Some(item) = pending {
        out.push(item);
    }
    out
}

/// 把整本 txt 切成章节 (标题, 正文)。优先按"第X章"标题切（网文）；否则按 ~5 万字切块。
/// 切块是为了"虚拟化加载"：打开只排第一章，其余在后台测量。
pub fn build_txt_chapters(text: &str) -> Vec<(String, String)> {
    let lines: Vec<&str> = text.split('\n').collect();
    let heads: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| is_txt_heading(l))
        .map(|(i, _)| i)
        .collect();
    // 标题足够多、又不至于每行都是 → 按标题切
    if heads.len() >= 5 && heads.len() * 3 < lines.len() * 2 {
        let mut out: Vec<(String, String)> = Vec::new();
        if heads[0] > 0 {
            let pre = lines[..heads[0]].join("\n");
            if !pre.trim().is_empty() {
                out.push(("卷首".to_string(), pre));
            }
        }
        for (k, &h) in heads.iter().enumerate() {
            let end = if k + 1 < heads.len() {
                heads[k + 1]
            } else {
                lines.len()
            };
            out.push((lines[h].trim().to_string(), lines[h..end].join("\n")));
        }
        return merge_title_only_txt_chapters(out);
    }
    // 否则按 ~5 万字切块
    let mut out: Vec<(String, String)> = Vec::new();
    let mut cur = String::new();
    let mut n = 0usize;
    for line in &lines {
        cur.push_str(line);
        cur.push('\n');
        n += line.chars().count() + 1;
        if n >= 50000 {
            out.push((format!("第 {} 节", out.len() + 1), std::mem::take(&mut cur)));
            n = 0;
        }
    }
    if !cur.trim().is_empty() {
        out.push((format!("第 {} 节", out.len() + 1), cur));
    }
    if out.is_empty() {
        out.push(("正文".to_string(), text.to_string()));
    }
    out
}

/// 取一行的 markdown 一级/二级标题文字（# 或 ##），否则 None。
fn md_heading_title(line: &str) -> Option<String> {
    let t = line.trim_start();
    if t.starts_with("# ") || t.starts_with("## ") {
        Some(t.trim_start_matches('#').trim().to_string())
    } else {
        None
    }
}

/// markdown 文件按 # / ## 标题切章；标题不足 2 个则整篇一章。
pub fn build_md_chapters(text: &str) -> Vec<(String, String)> {
    let lines: Vec<&str> = text.split('\n').collect();
    let heads: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| md_heading_title(l).is_some())
        .map(|(i, _)| i)
        .collect();
    if heads.len() < 2 {
        return vec![("正文".to_string(), text.to_string())];
    }
    let mut out: Vec<(String, String)> = Vec::new();
    if heads[0] > 0 {
        let pre = lines[..heads[0]].join("\n");
        if !pre.trim().is_empty() {
            out.push(("开头".to_string(), pre));
        }
    }
    for (k, &h) in heads.iter().enumerate() {
        let end = if k + 1 < heads.len() {
            heads[k + 1]
        } else {
            lines.len()
        };
        let title = md_heading_title(lines[h]).unwrap_or_default();
        out.push((title, lines[h..end].join("\n")));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{build_md_chapters, build_txt_chapters, is_txt_heading};

    #[test]
    fn detects_common_chinese_chapter_headings() {
        assert!(is_txt_heading("第1章 逃亡"));
        assert!(is_txt_heading("第二回 风雪夜"));
        assert!(is_txt_heading("序章"));
        assert!(!is_txt_heading("这是一段普通正文。"));
        assert!(!is_txt_heading("第1章 ".repeat(20).as_str()));
    }

    #[test]
    fn splits_txt_by_real_headings_and_keeps_preface() {
        let text = "题记\n第1章 一\n正文一\n第2章 二\n正文二\n第3章 三\n正文三\n第4章 四\n正文四\n第5章 五\n正文五";
        let chapters = build_txt_chapters(text);
        assert_eq!(chapters.len(), 6);
        assert_eq!(chapters[0].0, "卷首");
        assert_eq!(chapters[1].0, "第1章 一");
        assert!(chapters[1].1.contains("正文一"));
    }

    #[test]
    fn merges_title_only_txt_chapter_with_following_body() {
        let text = "第1章 起\n第2章 承\n这是第二章正文\n第3章 转\n这是第三章正文\n第4章 合\n这是第四章正文\n第5章 尾\n这是第五章正文";
        let chapters = build_txt_chapters(text);
        assert_eq!(chapters[0].0, "第1章 起");
        assert!(chapters[0].1.contains("第2章 承"));
        assert!(chapters[0].1.contains("这是第二章正文"));
    }

    #[test]
    fn falls_back_to_single_txt_section_when_no_headings() {
        let chapters = build_txt_chapters("只有普通正文\n没有章节标题");
        assert_eq!(chapters.len(), 1);
        assert_eq!(chapters[0].0, "第 1 节");
    }

    #[test]
    fn splits_markdown_by_h1_and_h2() {
        let text = "intro\n# 第一章\n正文一\n## 第二节\n正文二";
        let chapters = build_md_chapters(text);
        assert_eq!(chapters.len(), 3);
        assert_eq!(chapters[0].0, "开头");
        assert_eq!(chapters[1].0, "第一章");
        assert_eq!(chapters[2].0, "第二节");
    }

    #[test]
    fn keeps_markdown_as_one_chapter_when_headings_are_sparse() {
        let chapters = build_md_chapters("# 标题\n正文");
        assert_eq!(
            chapters,
            vec![("正文".to_string(), "# 标题\n正文".to_string())]
        );
    }
}
