const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ui = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ui, "index.html"), "utf8");
const styles = fs.readFileSync(path.join(ui, "styles.css"), "utf8");
const controller = fs.readFileSync(path.join(ui, "library-ai.js"), "utf8");
const entry = fs.readFileSync(path.join(ui, "library-ai-entry.js"), "utf8");
const backend = fs.readFileSync(path.join(ui, "..", "src", "ai_reader.rs"), "utf8");

test("library assistant is mounted inside the main window content area", () => {
  assert.match(html, /id="library-ai-page"/);
  assert.match(html, /id="library-ai-back"/);
  assert.match(html, /<script src="library-ai\.js"><\/script>/);
  assert.match(html, /<script src="library-ai-entry\.js"><\/script>/);
  assert.match(styles, /\.library-ai-page\s*\{/);
  assert.match(styles, /\.library-ai-grid\s*\{[^}]*grid-template-columns/s);
  assert.match(styles, /@media \(max-width: 760px\)/);
});

test("library assistant opens lazily in the main window and can return to the shelf", () => {
  assert.match(entry, /shell\.hidden = true/);
  assert.match(entry, /page\.hidden = false/);
  assert.match(entry, /await assistant\.load\(\)/);
  assert.match(entry, /page\.hidden = true/);
  assert.match(entry, /shell\.hidden = false/);
  assert.match(entry, /event\.key === "Escape"/);
  assert.doesNotMatch(entry, /open_library_ai_window/);
  assert.match(controller, /function init\(/);
  assert.match(controller, /initialized lazily/);
});

test("library assistant gives multi-stage RAG calls enough time without allowing unbounded answers", () => {
  assert.match(backend, /READING_PROVIDER_RESPONSE_TIMEOUT[^\n]*from_secs\(120\)/);
  assert.match(backend, /READING_PROVIDER_MAX_TOKENS: u16 = 1_600/);
  assert.match(backend, /"max_tokens": READING_PROVIDER_MAX_TOKENS/);
  assert.doesNotMatch(backend, /timeout_recv_response\(Some\(std::time::Duration::from_secs\(45\)\)\)/);
});

test("library question Enter submits while Shift+Enter keeps a newline", () => {
  assert.match(controller, /event\.key === "Enter" && !event\.shiftKey && !event\.isComposing && event\.keyCode !== 229/);
  assert.match(controller, /event\.preventDefault\(\);\s*void run\(\);/);
});

test("library question input has a copy-cut-paste-only right-click menu", () => {
  const app = fs.readFileSync(path.join(ui, "app.js"), "utf8");
  assert.match(app, /contextmenu", \(e\) => e\.preventDefault\(\)/);
  assert.match(controller, /function showQuestionContextMenu/);
  assert.match(controller, /addAction\(i18n\("copy", "复制"\)/);
  assert.match(controller, /addAction\(i18n\("cut", "剪切"\)/);
  assert.match(controller, /addAction\(i18n\("paste", "粘贴"\)/);
  assert.match(controller, /question\.setRangeText\("", start, end, "start"\)/);
  assert.match(controller, /navigator\?\.clipboard\?\.readText/);
  assert.match(styles, /\.library-ai-question-menu\s*\{/);
});

test("library assistant toolbar toggles back to the shelf when it is already open", () => {
  assert.match(entry, /function toggle\(\) \{\s*if \(page\.hidden\) \{\s*void open\(\);\s*\} else \{\s*close\(\);/s);
  assert.match(entry, /button\.addEventListener\("click", toggle\)/);
});

test("library assistant keeps whole-library as the unselected default and offers scoped selection tools", () => {
  assert.match(html, /id="scope-summary"[^>]*>当前范围：全部书库/);
  assert.match(html, /id="clear-selection"[^>]*>取消限定/);
  assert.match(html, /id="select-visible"[^>]*>全选当前列表/);
  assert.match(html, /id="invert-visible"[^>]*>反选当前列表/);
  assert.match(html, /展示最相关的前 20 本（每本 1 段）/);
  assert.match(controller, /const selectedBookIds = new Set\(\)/);
  assert.match(controller, /const MAX_QUESTION_SOURCES = 20/);
  assert.match(controller, /function selectVisibleBooks\(\)/);
  assert.match(controller, /function invertVisibleBooks\(\)/);
  assert.match(controller, /正在检索全部书库，并筛选可支撑回答的文本证据/);
  assert.match(controller, /selectedBookIdsForRequest = selectedIds\(\)/);
  assert.match(controller, /selectedBookIds: selectedBookIdsForRequest/);
});

test("library assistant supports tag and collection quick filters", () => {
  assert.match(html, /id="tag-filter"/);
  assert.match(html, /id="collection-filter"/);
  assert.match(html, /未勾选不代表未参与：书库问答默认检索全部已建立语义索引的图书/);
  assert.match(controller, /tagsForBook/);
  assert.match(controller, /book\.tags/);
  assert.match(controller, /book\.modelTags/);
  assert.match(controller, /book\.collections/);
  assert.match(controller, /显示 \$\{visibleBooks\.length\} \/ 共 \$\{books\.length\} 本/);
});

test("library assistant can choose one of the locally configured large models", () => {
  const app = fs.readFileSync(path.join(ui, "app.js"), "utf8");
  const apiSettings = fs.readFileSync(path.join(ui, "api-settings-ui.js"), "utf8");
  const reader = fs.readFileSync(path.join(ui, "reader.js"), "utf8");
  const readerHtml = fs.readFileSync(path.join(ui, "reader.html"), "utf8");
  const annotations = fs.readFileSync(path.join(ui, "reader-page-annotations.js"), "utf8");
  const translate = fs.readFileSync(path.join(ui, "..", "src", "translate.rs"), "utf8");
  const commands = fs.readFileSync(path.join(ui, "..", "src", "app_commands.rs"), "utf8");
  assert.match(html, /id="api-settings-open"/);
  assert.match(html, /id="api-settings-modal"/);
  assert.match(html, /id="api-ai-profile"/);
  assert.match(html, /id="api-ai-preset"[\s\S]*?DeepSeek[\s\S]*?OpenAI（GPT）[\s\S]*?Anthropic（Claude）[\s\S]*?OpenAI 兼容接口/);
  assert.match(html, /id="api-translation-provider"/);
  assert.match(html, /id="library-ai-model-profile"/);
  assert.match(html, /<script src="api-settings-ui\.js"><\/script>/);
  assert.match(app, /ReaderApiSettingsUI\?\.init\(\{ invoke \}\)/);
  assert.match(apiSettings, /invoke\("ai_reader_profiles"\)/);
  assert.match(apiSettings, /invoke\("save_ai_reader_profile"/);
  assert.match(apiSettings, /invoke\("translation_credentials_status"\)/);
  assert.match(apiSettings, /notifyProfilesChanged/);
  assert.doesNotMatch(apiSettings, /api-ai-new/);
  assert.match(controller, /function renderModelProfiles/);
  assert.match(controller, /select_ai_reader_profile/);
  assert.match(html, /library-ai-head-actions[\s\S]*?id="library-ai-model-profile"/);
  assert.match(readerHtml, /id="ai-reader-profile"/);
  assert.match(reader, /renderAiReaderProfiles/);
  assert.match(annotations, /getTranslationProfiles/);
  assert.match(annotations, /function applyTranslationProfiles/);
  assert.match(backend, /CONFIG_PROFILES_KEY/);
  assert.match(backend, /fn persist_profiles/);
  assert.match(backend, /profile_summary_never_exposes_the_api_key/);
  assert.match(translate, /TRANSLATION_ACTIVE_PROVIDER_KEY/);
  assert.match(translate, /fn translation_credentials_status/);
  assert.match(commands, /translation_credentials_status/);
});

test("library assistant classifies model tags with progress and can use them independently from manual tags", () => {
  assert.match(html, /id="library-ai-classify"[^>]*>书籍分类/);
  assert.match(html, /id="library-ai-classify-status"[^>]*hidden/);
  assert.doesNotMatch(html, /本地资料不足时，会检索百度和豆瓣读书/);
  assert.match(controller, /start_library_auto_classification/);
  assert.match(controller, /library_profile_status/);
  assert.match(controller, /library_profile_coverage_status/);
  assert.match(controller, /完成：\$\{total\} 本图书的分类/);
  assert.match(controller, /button\.title = label/);
  assert.match(controller, /未覆盖完整八维/);
  assert.match(backend, /LibraryClassification/);
  assert.match(backend, /library_book_classify/);
  assert.match(backend, /model_tags_by_book/);
  assert.match(backend, /boost_results_with_profiles/);
  assert.match(backend, /needsWebSearch/);
  assert.match(backend, /public_catalog_evidence/);
  assert.match(backend, /LIBRARY_WEB_LOOKUP_EVERY_BOOKS/);
  assert.match(backend, /LIBRARY_WEB_LOOKUP_DELAY/);
  assert.match(backend, /PendingLibraryWebClassification/);
  assert.match(backend, /LIBRARY_PROFILE_DIMENSIONS/);
  assert.match(backend, /profile_has_all_dimensions/);
  assert.match(backend, /profile_is_settled/);
  assert.match(backend, /library_classification_checkpoint/);
  assert.match(backend, /enqueue_or_resume/);
  assert.match(backend, /library_profile_coverage_status/);
  assert.match(backend, /豆瓣读书/);
  assert.doesNotMatch(html, /library-ai-tag-mode/);
  assert.doesNotMatch(html, /library-ai-promote-tags/);
  assert.doesNotMatch(controller, /promote_library_dark_tags/);
  assert.doesNotMatch(backend, /promote_library_dark_tags/);
  assert.match(styles, /\.library-ai-classify\s*\{[^}]*white-space:nowrap/s);
  assert.match(styles, /\.library-ai-classify-status\s*\{[^}]*text-overflow:ellipsis/s);
  assert.match(controller, /task\?\.state === "paused"/);
  assert.match(controller, /从已保存的位置继续/);
});

test("common settings can opt into model classification tags without changing their sync behavior", () => {
  const app = fs.readFileSync(path.join(ui, "app.js"), "utf8");
  assert.match(html, /id="set-use-model-tags"/);
  assert.match(html, /使用大模型分类的标签/);
  assert.match(app, /library_model_tags_settings/);
  assert.match(app, /set_library_model_tags_enabled/);
  assert.match(app, /library-model-tags-setting-changed/);
  assert.match(backend, /LIBRARY_MODEL_TAGS_ENABLED_KEY/);
  assert.match(backend, /materialize_library_profiles_into_model_tags/);
  assert.match(backend, /大模型标签始终参与问答/);
});

test("book information shows manual and model tags together with an explicit source marker", () => {
  const app = fs.readFileSync(path.join(ui, "app.js"), "utf8");
  const reader = fs.readFileSync(path.join(ui, "reader.js"), "utf8");
  assert.match(app, /renderBookInfoTags\(document\.getElementById\("book-info-tags"\), m\.tags, m\.model_tags \|\| m\.modelTags\)/);
  assert.match(reader, /renderBookInfoTags\(document\.getElementById\("info-tags"\), m\.tags, m\.model_tags \|\| m\.modelTags\)/);
  assert.match(app, /info-chip-origin/);
  assert.match(styles, /\.info-chip\.model-tag/);
});

test("question keeps twenty diverse sources while comparison remains bounded", () => {
  assert.match(controller, /const MAX_COMPARE_BOOKS = 8/);
  assert.match(backend, /const MAX_LIBRARY_QUESTION_SOURCES: usize = 20/);
  assert.match(backend, /const MAX_LIBRARY_COMPARE_BOOKS: usize = 8/);
  assert.match(backend, /const MAX_LIBRARY_COMPARE_SOURCES: usize = 8/);
  assert.match(backend, /fn full_library_semantic_scope/);
  assert.match(backend, /library_question_keeps_the_top_twenty_distinct_books/);
  assert.match(backend, /library_question_never_repeats_a_book_when_results_are_duplicated/);
  assert.match(backend, /library_evidence_filter/);
  assert.match(backend, /library_single_book_evidence_filter/);
  assert.match(backend, /library_single_book_question/);
  assert.match(backend, /library_single_book_verify/);
  assert.match(backend, /library_question_verify/);
  assert.match(backend, /library_compare_verify/);
  assert.match(backend, /single_book_depth_search/);
  assert.match(backend, /select_single_book_sources/);
  assert.match(backend, /implicit_single_book_id/);
  assert.match(backend, /explicit_book_titles/);
  assert.match(backend, /parse_deep_source_ids/);
  assert.match(controller, /书内多轮检索、证据筛选与自检/);
  assert.match(controller, /单书深度依据/);
  assert.match(controller, /正在识别题中书名/);
  assert.match(controller, /answer\.singleBook/);
});

test("answer citations render as hoverable, clickable source footnotes", () => {
  assert.match(html, /id="source-preview"/);
  assert.match(html, /id="source-preview-open"/);
  assert.match(controller, /function renderAnswer\(content, sources, \{ hideDirectAnswerHeading = false \} = \{\}\)/);
  assert.match(controller, /const token = \/\\\[来源\\s\*\(\\d\+\)\\\]\|\\\*\\\*\(\[\^\*\\n\]\+\)\\\*\\\*\/g/);
  assert.match(controller, /footnote\.addEventListener\("pointerenter"/);
  assert.match(controller, /showSourcePreview\(source, index, true,/);
  assert.doesNotMatch(controller, /footnote\.title/);
  assert.match(styles, /\.library-ai-footnote\s*\{/);
  assert.match(styles, /\.library-ai-source-preview\s*\{/);
  assert.match(styles, /\.library-ai-source-preview\s*\{[^}]*position:fixed/s);
});

test("library answers render a safe subset of Markdown instead of exposing raw markers", () => {
  assert.match(controller, /function appendAnswerInline\(parent, text, sources\)/);
  assert.match(controller, /heading\[1\]\.length === 1 \? "h3" : "h4"/);
  assert.match(controller, /appendListItem\("ul", bullet\[1\]\)/);
  assert.match(controller, /root\.createElement\("strong"\)/);
  assert.match(styles, /\.library-ai-answer h3/);
  assert.match(styles, /\.library-ai-answer-list/);
  assert.doesNotMatch(controller, /answerEl\.innerHTML/);
});

test("library answer provider accepts compatible response envelopes and retries an empty completion", () => {
  assert.match(backend, /choices\/0\/message\/reasoning_content/);
  assert.match(backend, /data\/choices\/0\/message\/content/);
  assert.match(backend, /Response\/Choices\/0\/Message\/Content/);
  assert.match(backend, /async fn call_library_answer_with_retry/);
  assert.match(backend, /MAX_READING_RETRY_CONTEXT_CHARS/);
});

test("library answers save locally and can sync a de-identified history", () => {
  assert.match(html, /id="library-ai-history"[^>]*>问答记录/);
  assert.match(html, /同步智读历史[\s\S]*包括单书与书库问答/);
  assert.match(controller, /private_sync_library_history_list/);
  assert.match(controller, /private_sync_library_history_merge/);
  assert.match(controller, /private_sync_library_history_delete/);
  assert.match(controller, /删除书库问答记录/);
  assert.match(controller, /HISTORY_SOURCES_KEY/);
  assert.match(controller, /writeLocalHistorySources/);
  assert.match(controller, /historySourcesForDisplay/);
  assert.match(controller, /recoverLegacyHistorySources/);
  assert.match(controller, /library_history_source_preview/);
  assert.match(controller, /contentId \|\| book\.content_id/);
  assert.match(controller, /replace\(\/\[《》〈〉“”‘’「」『』"'\]\//);
  assert.match(controller, /原书未加入本机书架或已从本机书架移除/);
  assert.match(controller, /function portableSourceReference\(source\)/);
  assert.match(controller, /bookTitle/);
  assert.match(controller, /sourceKind/);
  assert.doesNotMatch(controller.match(/function portableSourceReference\(source\)[\s\S]*?\n    }/)[0], /excerpt/);
  assert.doesNotMatch(controller.match(/function portableSourceReference\(source\)[\s\S]*?\n    }/)[0], /bookId/);
  assert.match(controller, /问答已保存到本机/);
  assert.match(controller, /下次同步时上传/);
  assert.match(controller, /function renderAnswer\(content, sources, \{ hideDirectAnswerHeading = false \} = \{\}\)/);
  assert.match(controller, /hideDirectAnswerHeading && heading\[2\]\.trim\(\) === "直接回答"/);
  assert.match(controller, /renderAnswer\(entry\.content, sources, \{ hideDirectAnswerHeading: true \}\)/);
  assert.doesNotMatch(controller, /renderLibraryHistoryAnswer/);
  assert.match(styles, /\.library-ai-history-list\s*\{/);
  assert.match(styles, /\.library-ai-history-delete\s*\{/);
  assert.doesNotMatch(styles, /\.library-ai-history-question-detail\s*\{/);
});

test("library assistant no longer creates a separate WebView", () => {
  assert.doesNotMatch(backend, /open_library_ai_window/);
  assert.doesNotMatch(backend, /library-ai\.html/);
});

test("library answer font size is adjusted in place and remembered locally", () => {
  assert.match(html, /id="library-ai-font-decrease"/);
  assert.match(html, /id="library-ai-font-size"/);
  assert.match(html, /id="library-ai-font-increase"/);
  assert.match(controller, /ANSWER_FONT_SIZE_KEY = "libraryAiAnswerFontSizeV1"/);
  assert.match(controller, /function applyAnswerFontSize\(save = false\)/);
  assert.match(controller, /localStorage\?\.setItem\(ANSWER_FONT_SIZE_KEY/);
  assert.match(styles, /--library-ai-answer-font-size/);
  assert.match(styles, /\.library-ai-font-controls\s*\{/);
});
