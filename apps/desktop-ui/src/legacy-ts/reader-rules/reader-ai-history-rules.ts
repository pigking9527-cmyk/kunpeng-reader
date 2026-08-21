export const READER_AI_HISTORY_TOMBSTONE_LIMIT = 200;
export const READER_AI_SESSION_STORAGE_LIMIT = 6;
export const READER_AI_SESSION_PROMPT_LIMIT = 4;
export const READER_AI_SESSION_QUESTION_LIMIT = 220;
export const READER_AI_SESSION_CONTENT_LIMIT = 760;
export const READER_AI_SESSION_PROMPT_CONTENT_LIMIT = 620;
export const READER_AI_SESSION_PROMPT_TOTAL_LIMIT = 2_800;

export interface ReaderAiHistoryEntry extends Readonly<Record<string, unknown>> {
  readonly id?: unknown;
  readonly at?: unknown;
  readonly deletedAt?: unknown;
  readonly deleted_at?: unknown;
  readonly task?: unknown;
  readonly question?: unknown;
  readonly content?: unknown;
}

export interface ReaderAiSessionEntry {
  readonly task: unknown;
  readonly question: string;
  readonly content: string;
  readonly at: unknown;
}

function entryRecord(value: unknown): ReaderAiHistoryEntry {
  return typeof value === "object" && value !== null
    ? value as ReaderAiHistoryEntry
    : Object.freeze({});
}

export function readerAiHistoryEntryId(entry: unknown): string {
  const record = entryRecord(entry);
  return String(record.id || `legacy:${record.at || "unknown"}`);
}

export function isReaderAiHistoryDeleted(entry: unknown): boolean {
  const record = entryRecord(entry);
  return Boolean(record.deletedAt || record.deleted_at);
}

export function mergeReaderAiHistoryEntries(
  ...groups: readonly (readonly unknown[])[]
): ReaderAiHistoryEntry[] {
  const byId = new Map<string, ReaderAiHistoryEntry>();
  groups.flat().filter(Boolean).forEach((entry) => {
    const record = entryRecord(entry);
    const normalized: ReaderAiHistoryEntry = {
      ...record,
      id: readerAiHistoryEntryId(record),
    };
    const id = String(normalized.id);
    const known = byId.get(id);
    if (isReaderAiHistoryDeleted(normalized) || !known || !isReaderAiHistoryDeleted(known)) {
      byId.set(id, normalized);
    }
  });
  const entries = Array.from(byId.values());
  const live = entries
    .filter((entry) => !isReaderAiHistoryDeleted(entry))
    .sort((left, right) => String(right.at || "").localeCompare(String(left.at || "")));
  const tombstones = entries
    .filter(isReaderAiHistoryDeleted)
    .sort((left, right) =>
      String(right.deletedAt || right.deleted_at || "").localeCompare(
        String(left.deletedAt || left.deleted_at || ""),
      ))
    .slice(0, READER_AI_HISTORY_TOMBSTONE_LIMIT);
  return [...live, ...tombstones];
}

export function prependReaderAiSessionEntry(
  entries: unknown,
  entry: unknown,
  now: () => string = () => new Date().toISOString(),
): ReaderAiSessionEntry[] {
  const existing = Array.isArray(entries) ? entries : [];
  const record = entryRecord(entry);
  return [
    {
      task: record.task || "question",
      question: String(record.question || "").slice(0, READER_AI_SESSION_QUESTION_LIMIT),
      content: String(record.content || "").slice(0, READER_AI_SESSION_CONTENT_LIMIT),
      at: record.at || now(),
    },
    ...existing,
  ].slice(0, READER_AI_SESSION_STORAGE_LIMIT);
}

export function readerAiSessionPrompt(
  entries: unknown,
  labelForTask?: unknown,
): string {
  const label = typeof labelForTask === "function"
    ? labelForTask as (task: unknown) => unknown
    : (task: unknown): string => String(task || "question");
  return (Array.isArray(entries) ? entries : [])
    .slice(0, READER_AI_SESSION_PROMPT_LIMIT)
    .map((entry, index) => {
      const record = entryRecord(entry);
      const task = label(record.task);
      return `会话 ${index + 1}（${String(task)}）：${String(record.content || "").slice(0, READER_AI_SESSION_PROMPT_CONTENT_LIMIT)}`;
    })
    .join("\n\n")
    .slice(0, READER_AI_SESSION_PROMPT_TOTAL_LIMIT);
}

export const readerAiHistoryRulesApi = Object.freeze({
  TOMBSTONE_LIMIT: READER_AI_HISTORY_TOMBSTONE_LIMIT,
  historyEntryId: readerAiHistoryEntryId,
  isHistoryDeleted: isReaderAiHistoryDeleted,
  mergeEntries: mergeReaderAiHistoryEntries,
  prependSessionEntry: prependReaderAiSessionEntry,
  sessionPrompt: readerAiSessionPrompt,
});

export type ReaderAiHistoryRulesApi = typeof readerAiHistoryRulesApi;

export function installReaderAiHistoryRules(
  target: Record<string, unknown>,
): ReaderAiHistoryRulesApi {
  target.ReaderAiHistoryRules = readerAiHistoryRulesApi;
  return readerAiHistoryRulesApi;
}
