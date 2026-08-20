/// 合并页的基础样式 + 分页脚本。
///
/// 注入页按职责拆分；编译期拼接为一个文档头，不增加运行时请求。
pub(crate) const READER_PAGE_HEAD: &str = concat!(
    include_str!("../ui/reader-page-style.html"),
    "<script>",
    include_str!("../ui/generated-reader-page-ts/reader-page-bug-trace.js"),
    include_str!("../ui/generated-reader-page-ts/reader-page-scroll-rules.js"),
    include_str!("../ui/generated-reader-page-ts/reader-page-layout-annotations.js"),
    include_str!("../ui/generated-reader-page-ts/reader-page-mode-switch.js"),
    include_str!("../ui/generated-reader-page-ts/reader-page-runtime.js"),
    include_str!("../ui/generated-reader-page-ts/reader-page-transition.js"),
    "</script>
"
);

#[cfg(test)]
mod tests {
    use super::READER_PAGE_HEAD;

    #[test]
    fn reader_page_head_keeps_required_hooks() {
        assert!(
            READER_PAGE_HEAD.contains("window.addEventListener('message'")
                || READER_PAGE_HEAD.contains("w.addEventListener(\"message\"")
        );
        assert!(READER_PAGE_HEAD.contains("function showChapter"));
        assert!(READER_PAGE_HEAD.contains("parent.postMessage"));
        assert!(READER_PAGE_HEAD.contains("ttsStart"));
        assert!(READER_PAGE_HEAD.contains("function showTranslateResult"));
        assert!(READER_PAGE_HEAD.contains("styleMode"));
        assert!(READER_PAGE_HEAD.contains("function showDictResult"));
        assert!(READER_PAGE_HEAD.contains("function showFootnote"));
        assert!(READER_PAGE_HEAD.contains("function measureAll"));
        assert!(READER_PAGE_HEAD.contains("Object.assign(global, api)"));
        assert!(READER_PAGE_HEAD.contains("function pageCountSig"));
        assert!(READER_PAGE_HEAD.contains("function renderHlSettings"));
        assert!(READER_PAGE_HEAD.contains("function applyConfiguredMenu"));
        assert!(READER_PAGE_HEAD.contains("highlightMenuActionsV1"));
        assert!(READER_PAGE_HEAD.contains("highlightMenuDisplayModeV1"));
        assert!(READER_PAGE_HEAD.contains("highlightMenuSizeV1"));
        assert!(READER_PAGE_HEAD.contains("semanticSearch"));
        assert!(READER_PAGE_HEAD.contains("translateResult"));
        assert!(READER_PAGE_HEAD.contains("dictResult"));
        let layout = READER_PAGE_HEAD.find("function showChapter").unwrap();
        // Generated IIFEs do not retain source comments, so assert order by stable
        // responsibility hooks from each of the six jointly compiled sections.
        let pagination = READER_PAGE_HEAD.find("function pageLayout").unwrap();
        let measurement = READER_PAGE_HEAD.find("function measureAll").unwrap();
        let annotations = READER_PAGE_HEAD.find("ReaderPageHighlightRules =").unwrap();
        let runtime = READER_PAGE_HEAD
            .find("function installReaderPageRuntime")
            .unwrap();
        assert!(
            layout < pagination
                && pagination < measurement
                && measurement < annotations
                && annotations < runtime
        );
    }
}
