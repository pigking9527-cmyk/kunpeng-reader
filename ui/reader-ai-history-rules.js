(function attachReaderAiHistoryRules(global) {
  "use strict";

  const TOMBSTONE_LIMIT = 200;
  const SESSION_STORAGE_LIMIT = 6;
  const SESSION_PROMPT_LIMIT = 4;
  const SESSION_QUESTION_LIMIT = 220;
  const SESSION_CONTENT_LIMIT = 760;
  const SESSION_PROMPT_CONTENT_LIMIT = 620;
  const SESSION_PROMPT_TOTAL_LIMIT = 2800;

  function historyEntryId(entry) {
    return String(entry?.id || `legacy:${entry?.at || "unknown"}`);
  }

  function isHistoryDeleted(entry) {
    return Boolean(entry?.deletedAt || entry?.deleted_at);
  }

  function mergeEntries(...groups) {
    const byId = new Map();
    groups.flat().filter(Boolean).forEach((entry) => {
      const normalized = { ...entry, id: historyEntryId(entry) };
      const known = byId.get(normalized.id);
      if (isHistoryDeleted(normalized) || !known || !isHistoryDeleted(known)) byId.set(normalized.id, normalized);
    });
    const entries = Array.from(byId.values());
    const live = entries.filter((entry) => !isHistoryDeleted(entry))
      .sort((left, right) => String(right.at || "").localeCompare(String(left.at || "")));
    const tombstones = entries.filter(isHistoryDeleted)
      .sort((left, right) => String(right.deletedAt || right.deleted_at || "").localeCompare(String(left.deletedAt || left.deleted_at || "")))
      .slice(0, TOMBSTONE_LIMIT);
    return [...live, ...tombstones];
  }

  function prependSessionEntry(entries, entry, now = () => new Date().toISOString()) {
    const existing = Array.isArray(entries) ? entries : [];
    return [{
      task: entry?.task || "question",
      question: String(entry?.question || "").slice(0, SESSION_QUESTION_LIMIT),
      content: String(entry?.content || "").slice(0, SESSION_CONTENT_LIMIT),
      at: entry?.at || now(),
    }, ...existing].slice(0, SESSION_STORAGE_LIMIT);
  }

  function sessionPrompt(entries, labelForTask) {
    const label = typeof labelForTask === "function" ? labelForTask : (task) => String(task || "question");
    return (Array.isArray(entries) ? entries : []).slice(0, SESSION_PROMPT_LIMIT).map((entry, index) => {
      const task = label(entry?.task);
      return `会话 ${index + 1}（${task}）：${String(entry?.content || "").slice(0, SESSION_PROMPT_CONTENT_LIMIT)}`;
    }).join("\n\n").slice(0, SESSION_PROMPT_TOTAL_LIMIT);
  }

  global.ReaderAiHistoryRules = Object.freeze({
    TOMBSTONE_LIMIT,
    historyEntryId,
    isHistoryDeleted,
    mergeEntries,
    prependSessionEntry,
    sessionPrompt,
  });
}(window));
