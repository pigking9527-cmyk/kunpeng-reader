/**
 * Capability boundary for Library Q&A and semantic setup.
 *
 * A composition root adapts native commands/events to this port.  This feature
 * intentionally has no Tauri import and no runtime-global access.  More
 * importantly, these view models deliberately exclude book bodies, local
 * paths, API keys, provider endpoints and raw transport error text.
 */

export type LibraryAiTask = "question" | "compare" | "recommend";
export type LibraryBookId = string;
export type AnswerLength = "short" | "medium" | "long";
export type HistorySyncMode = "off" | "recent" | "manual";
export type SemanticModelId = "bge-small-zh-v1.5" | "bge-large-zh-v1.5" | "bge-m3" | "multilingual-e5-small" | string;
export type SemanticTaskKind = "idle" | "model-download" | "index-build" | "paused" | "unavailable";

export interface LibraryAiBook {
  readonly id: LibraryBookId;
  readonly title: string;
  readonly author?: string;
  readonly tags: readonly string[];
  readonly collections: readonly string[];
  /** Host-derived availability; never expose a local filesystem path. */
  readonly available: boolean;
}

/** Metadata only. Excerpts and raw chapter text never enter feature state. */
export interface LibraryAiSource {
  readonly bookId: LibraryBookId;
  readonly bookTitle: string;
  readonly chapter: number;
  readonly sourceIndex: number;
  readonly sourceKind?: string;
  readonly available: boolean;
}

export interface LibraryRecommendationItem {
  readonly bookId: LibraryBookId;
  readonly title: string;
  /** A model-written review, not source text from the book. */
  readonly review: string;
}

export interface LibraryRecommendation {
  readonly summary: string;
  readonly items: readonly LibraryRecommendationItem[];
}

export interface LibraryAiAnswer {
  /** Generated answer only; the port must not return a raw retrieved body. */
  readonly content: string;
  readonly sources: readonly LibraryAiSource[];
  readonly singleBook: boolean;
  readonly citationChecked: boolean;
  readonly retrievalStages: readonly string[];
  readonly recommendation?: LibraryRecommendation;
}

export type QueryProgressStage = "retrieving" | "generating" | "verifying";

export interface QueryProgress {
  readonly stage: QueryProgressStage;
  /** A bounded display label supplied by the adapter; never include query/context/error text. */
  readonly label: string;
}

export interface LibraryAiQuery {
  readonly task: LibraryAiTask;
  readonly question: string;
  readonly selectedBookIds: readonly LibraryBookId[];
}

export interface LibraryAiHistoryEntry {
  readonly id: string;
  readonly task: LibraryAiTask;
  readonly question: string;
  readonly answer: string;
  readonly createdAt: string;
  readonly sources: readonly LibraryAiSource[];
  readonly cloudSaved: boolean;
}

export interface LibraryAiHistorySnapshot {
  readonly entries: readonly LibraryAiHistoryEntry[];
  readonly syncMode: HistorySyncMode;
}

export interface SemanticStatus {
  readonly modelId: SemanticModelId;
  readonly modelLabel: string;
  readonly modelReady: boolean;
  readonly modelDownloadedBytes: number;
  readonly modelTotalBytes: number;
  readonly indexReady: boolean;
  readonly indexedBooks: number;
  readonly totalBooks: number;
  readonly task: SemanticTaskKind;
  readonly m3LongContextEnabled: boolean;
}

export interface SemanticModelOption {
  readonly id: SemanticModelId;
  readonly label: string;
}

export interface LibraryAiSettings {
  readonly answerLength: AnswerLength;
  readonly recommendationCandidateLimit: number;
  readonly recommendationResultLimit: number;
}

export interface LibraryAiBootstrap {
  readonly configured: boolean;
  readonly books: readonly LibraryAiBook[];
  readonly semantic: SemanticStatus;
  readonly semanticModels: readonly SemanticModelOption[];
  readonly settings: LibraryAiSettings;
  readonly history: LibraryAiHistorySnapshot;
}

/** Expected, deliberately non-diagnostic failure categories from an adapter. */
export class LibraryAiPortError extends Error {
  public constructor(
    public readonly kind: "offline" | "not-configured" | "index-unavailable" | "cancelled" | "unavailable",
  ) {
    super(kind);
    this.name = "LibraryAiPortError";
  }
}

export interface LibraryAiPort {
  load(signal: AbortSignal): Promise<LibraryAiBootstrap>;
  ask(query: LibraryAiQuery, signal: AbortSignal, onProgress: (progress: QueryProgress) => void): Promise<LibraryAiAnswer>;
  cancelQuery(): Promise<void>;
  openSource(bookId: LibraryBookId, chapter: number, signal: AbortSignal): Promise<void>;

  refreshSemanticStatus(signal: AbortSignal): Promise<SemanticStatus>;
  downloadSemanticModel(signal: AbortSignal, onProgress: (status: SemanticStatus) => void): Promise<SemanticStatus>;
  buildSemanticIndex(signal: AbortSignal, onProgress: (status: SemanticStatus) => void): Promise<SemanticStatus>;
  pauseSemanticIndex(signal: AbortSignal): Promise<SemanticStatus>;
  selectSemanticModel(modelId: SemanticModelId, signal: AbortSignal): Promise<SemanticStatus>;
  setM3LongContext(enabled: boolean, signal: AbortSignal): Promise<SemanticStatus>;

  saveSettings(settings: LibraryAiSettings, signal: AbortSignal): Promise<LibraryAiSettings>;
  listHistory(signal: AbortSignal): Promise<LibraryAiHistorySnapshot>;
  setHistoryCloudSaved(entryId: string, saved: boolean, signal: AbortSignal): Promise<LibraryAiHistorySnapshot>;
  deleteHistory(entryId: string, signal: AbortSignal): Promise<LibraryAiHistorySnapshot>;
}
