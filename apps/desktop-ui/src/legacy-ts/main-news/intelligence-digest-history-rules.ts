/**
 * Pure, local-only rules for the daily Intelligence Center briefing archive.
 *
 * The UI and the model adapter deliberately stay outside this module: model
 * output is untrusted input here, while a saved digest is a compact,
 * deterministic projection that can be rendered or stored safely.
 */

export const DAILY_DIGEST_DEFAULT_ENTRY_COUNT = 25;
export const DAILY_DIGEST_MIN_ENTRY_COUNT = 20;
export const DAILY_DIGEST_MAX_ENTRY_COUNT = 30;
export const DAILY_DIGEST_MAX_ID_LENGTH = 160;
export const DAILY_DIGEST_MAX_HEADLINE_LENGTH = 240;
export const DAILY_DIGEST_MAX_SUMMARY_LENGTH = 1_800;
export const DAILY_DIGEST_MAX_WHY_IT_MATTERS_LENGTH = 900;
export const DAILY_DIGEST_MAX_REASON_COUNT = 8;
export const DAILY_DIGEST_MAX_REASON_LENGTH = 240;

export type DailyDigestPriority = "P0" | "P1" | "P2";

export interface IntelligenceDigestEntryInput {
  readonly id: unknown;
  readonly importance?: unknown;
  readonly confidence?: unknown;
  readonly priority?: unknown;
  readonly headline?: unknown;
  readonly summary?: unknown;
  readonly whyItMatters?: unknown;
  readonly reasons?: unknown;
}

export interface IntelligenceDigestEntry {
  readonly id: string;
  readonly importance: number;
  readonly confidence: number;
  readonly priority: DailyDigestPriority;
  readonly headline: string;
  readonly summary: string;
  readonly whyItMatters: string;
  readonly reasons: readonly string[];
}

export interface DailyDigestSnapshotInput {
  readonly day: unknown;
  readonly createdAtMs: unknown;
  readonly entries: unknown;
}

export interface DailyDigestSnapshot {
  /** Local calendar date in YYYY-MM-DD form; it is intentionally not UTC. */
  readonly day: string;
  readonly createdAtMs: number;
  readonly entries: readonly IntelligenceDigestEntry[];
}

export interface DailyDigestSelectionOptions {
  /** Desired number of entries; clamped to the product range of 20–30. */
  readonly targetCount?: number;
}

export type DailyDigestRolloverDecision =
  | {
    readonly action: "keep";
    readonly day: string;
    readonly archiveSnapshot: null;
  }
  | {
    readonly action: "create" | "rollover";
    readonly day: string;
    /** The previous local day must be added to history before a new one starts. */
    readonly archiveSnapshot: DailyDigestSnapshot | null;
  };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boundedText(value: unknown, maximumLength: number): string {
  if (typeof value !== "string") return "";
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(0, maximumLength);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isDailyDigestPriority(value: unknown): value is DailyDigestPriority {
  return value === "P0" || value === "P1" || value === "P2";
}

function entrySignature(entry: IntelligenceDigestEntry): string {
  return [
    entry.id,
    entry.headline,
    entry.summary,
    entry.whyItMatters,
    entry.priority,
    entry.reasons.join("\u001F"),
  ].join("\u001E");
}

function compareDigestEntries(left: IntelligenceDigestEntry, right: IntelligenceDigestEntry): number {
  if (left.importance !== right.importance) return right.importance - left.importance;
  if (left.confidence !== right.confidence) return right.confidence - left.confidence;
  const idComparison = compareText(left.id, right.id);
  return idComparison !== 0 ? idComparison : compareText(entrySignature(left), entrySignature(right));
}

function normalizedTargetCount(value: number | undefined): number {
  const requested = finiteNumber(value, DAILY_DIGEST_DEFAULT_ENTRY_COUNT);
  return clamp(Math.round(requested), DAILY_DIGEST_MIN_ENTRY_COUNT, DAILY_DIGEST_MAX_ENTRY_COUNT);
}

/**
 * Sanitizes one model/rules candidate without mutating it. Invalid IDs are not
 * made up: callers cannot accidentally save a model-invented anonymous item.
 */
export function sanitizeIntelligenceDigestEntry(
  input: IntelligenceDigestEntryInput | unknown,
): IntelligenceDigestEntry | null {
  const record = asRecord(input);
  if (!record) return null;

  const id = boundedText(record.id, DAILY_DIGEST_MAX_ID_LENGTH);
  if (!id) return null;

  const rawReasons = Array.isArray(record.reasons) ? record.reasons : [];
  const reasons = rawReasons
    .map((reason) => boundedText(reason, DAILY_DIGEST_MAX_REASON_LENGTH))
    .filter((reason) => reason.length > 0)
    .slice(0, DAILY_DIGEST_MAX_REASON_COUNT);

  return Object.freeze({
    id,
    importance: clamp(finiteNumber(record.importance, 0), 0, 100),
    confidence: clamp(finiteNumber(record.confidence, 0), 0, 1),
    priority: isDailyDigestPriority(record.priority) ? record.priority : "P2",
    headline: boundedText(record.headline, DAILY_DIGEST_MAX_HEADLINE_LENGTH),
    summary: boundedText(record.summary, DAILY_DIGEST_MAX_SUMMARY_LENGTH),
    whyItMatters: boundedText(record.whyItMatters, DAILY_DIGEST_MAX_WHY_IT_MATTERS_LENGTH),
    reasons: Object.freeze(reasons),
  });
}

/**
 * Selects the daily headline set. Entries are ranked by importance,
 * confidence, then stable ID; duplicate IDs are folded deterministically.
 */
export function selectDailyDigestEntries(
  entries: readonly unknown[],
  options: DailyDigestSelectionOptions = {},
): readonly IntelligenceDigestEntry[] {
  const normalized = entries
    .map((entry) => sanitizeIntelligenceDigestEntry(entry))
    .filter((entry): entry is IntelligenceDigestEntry => entry !== null)
    .sort(compareDigestEntries);
  const unique = normalized.filter((entry, index) => index === 0 || entry.id !== normalized[index - 1]?.id);
  const count = Math.min(unique.length, normalizedTargetCount(options.targetCount));
  return Object.freeze(unique.slice(0, count));
}

/** Returns an unambiguous local calendar day without converting through UTC. */
export function localDailyDigestDay(date: Date = new Date()): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new RangeError("A valid local Date is required for a daily digest.");
  }
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isLocalDayKey(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

/** Produces the bounded snapshot that is persisted for a local calendar day. */
export function createDailyDigestSnapshot(
  entries: readonly unknown[],
  now: Date = new Date(),
  options: DailyDigestSelectionOptions = {},
): DailyDigestSnapshot {
  const day = localDailyDigestDay(now);
  return Object.freeze({
    day,
    createdAtMs: now.getTime(),
    entries: selectDailyDigestEntries(entries, options),
  });
}

/** Sanitizes a persisted snapshot before it is used for display or history. */
export function sanitizeDailyDigestSnapshot(input: DailyDigestSnapshotInput | unknown): DailyDigestSnapshot | null {
  const record = asRecord(input);
  if (!record) return null;
  const day = boundedText(record.day, 10);
  if (!isLocalDayKey(day) || !Array.isArray(record.entries)) return null;
  const createdAtMs = finiteNumber(record.createdAtMs, NaN);
  if (!Number.isFinite(createdAtMs)) return null;
  return Object.freeze({
    day,
    createdAtMs,
    entries: selectDailyDigestEntries(record.entries),
  });
}

/**
 * Decides whether the caller continues today's draft or archives the previous
 * local-day snapshot and starts a new one. It never mutates storage itself.
 */
export function decideDailyDigestRollover(
  current: DailyDigestSnapshotInput | DailyDigestSnapshot | null | undefined,
  now: Date = new Date(),
): DailyDigestRolloverDecision {
  const day = localDailyDigestDay(now);
  const snapshot = sanitizeDailyDigestSnapshot(current);
  if (!snapshot) return Object.freeze({ action: "create", day, archiveSnapshot: null });
  if (snapshot.day === day) return Object.freeze({ action: "keep", day, archiveSnapshot: null });
  return Object.freeze({ action: "rollover", day, archiveSnapshot: snapshot });
}

function compareSnapshots(left: DailyDigestSnapshot, right: DailyDigestSnapshot): number {
  const dayComparison = compareText(right.day, left.day);
  if (dayComparison !== 0) return dayComparison;
  if (left.createdAtMs !== right.createdAtMs) return right.createdAtMs - left.createdAtMs;
  return compareText(left.entries.map(entrySignature).join("\u001D"), right.entries.map(entrySignature).join("\u001D"));
}

/**
 * Normalizes persisted history into one snapshot per day, newest local day
 * first. Existing malformed/oversized records are discarded or bounded.
 */
export function sortDailyDigestHistory(
  snapshots: readonly (DailyDigestSnapshotInput | DailyDigestSnapshot | unknown)[],
): readonly DailyDigestSnapshot[] {
  const ordered = snapshots
    .map((snapshot) => sanitizeDailyDigestSnapshot(snapshot))
    .filter((snapshot): snapshot is DailyDigestSnapshot => snapshot !== null)
    .sort(compareSnapshots);
  const days = new Set<string>();
  return Object.freeze(ordered.filter((snapshot) => {
    if (days.has(snapshot.day)) return false;
    days.add(snapshot.day);
    return true;
  }));
}
