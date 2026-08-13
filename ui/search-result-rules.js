// 搜索结果窗口的无副作用规则。search.html 未加载此文件时，search.js 保留同形状回退，
// 以避免窗口脚本装载顺序改变影响已发布的 WebView。
(function registerReaderSearchResultRules(global) {
  "use strict";

  const CJK_CHARACTER = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
  const CJK_CHARACTER_GLOBAL = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu;

  function escapeHtml(value) {
    return String(value).replace(/[&<>]/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
    }[character]));
  }

  function cjkNgramsForHighlight(text) {
    const characters = Array.from(String(text).match(CJK_CHARACTER_GLOBAL) || []);
    const result = [];
    for (const size of [3, 2]) {
      if (characters.length < size) continue;
      for (let index = 0; index + size <= characters.length; index += 1) {
        result.push(characters.slice(index, index + size).join(""));
      }
    }
    return result;
  }

  function highlightNeedles(term) {
    const raw = String(term || "").trim();
    const seen = new Set();
    const result = [];
    function add(value, allowSingleCjk) {
      const normalized = String(value || "").trim();
      if (normalized.length < 2 && !allowSingleCjk) return;
      const key = normalized.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(normalized);
      }
    }
    add(raw, CJK_CHARACTER.test(raw));
    (raw.match(/[A-Za-z0-9]{2,}/g) || []).forEach(add);
    cjkNgramsForHighlight(raw).forEach(add);
    return result.sort((left, right) => right.length - left.length);
  }

  function highlightSnippet(snippet, term) {
    const text = String(snippet || "");
    const needles = highlightNeedles(term);
    if (!needles.length) return escapeHtml(text);
    const lowerCaseText = text.toLowerCase();
    let html = "";
    let position = 0;
    while (position < text.length) {
      const match = needles.find((needle) => lowerCaseText.startsWith(needle.toLowerCase(), position));
      if (match) {
        html += "<mark>" + escapeHtml(text.slice(position, position + match.length)) + "</mark>";
        position += match.length;
      } else {
        html += escapeHtml(text[position]);
        position += 1;
      }
    }
    return html;
  }

  function sortSearchResults(list, mode) {
    const results = Array.isArray(list) ? list.slice() : [];
    if (mode === "title") results.sort((left, right) => (left.title || "").localeCompare(right.title || "", "zh"));
    else if (mode === "author") results.sort((left, right) => (left.author || "").localeCompare(right.author || "", "zh"));
    else if (mode === "hits") results.sort((left, right) => right.count - left.count);
    else results.sort((left, right) => (right.score || right.count || 0) - (left.score || left.count || 0));
    return results;
  }

  global.ReaderSearchResultRules = Object.freeze({
    escapeHtml,
    cjkNgramsForHighlight,
    highlightNeedles,
    highlightSnippet,
    sortSearchResults,
  });
}(window));
