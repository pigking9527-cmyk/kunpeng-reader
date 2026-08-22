/**
 * Capability boundary for the general settings migration.
 *
 * The host owns native commands, directory pickers, persistence and event
 * subscriptions.  Directory labels are intentionally display-only: a local
 * filesystem path must never enter this feature's state, markup or tests.
 */

export interface AutoImportDirectory {
  /** Stable opaque host identifier, suitable for remove/save requests. */
  readonly id: string;
  /** A host-sanitised display label, never an absolute or relative path. */
  readonly label: string;
  /** Whether the host can currently read this directory. */
  readonly permission: "granted" | "needs-attention" | "unavailable";
}

export interface AutoImportSettings {
  readonly enabled: boolean;
  readonly directories: readonly AutoImportDirectory[];
}

export type AutoImportProgressPhase = "scan" | "import" | "waiting" | "done" | "permission-denied";

/** Progress contains counts and a bounded safe label, never an imported path. */
export interface AutoImportProgress {
  readonly phase: AutoImportProgressPhase;
  readonly found: number;
  readonly processed: number;
  readonly total: number;
  readonly added: number;
  readonly deferred: number;
  readonly currentLabel?: string;
}

export interface AutoImportScanResult {
  readonly added: number;
}

export type ClassificationTaskState = "idle" | "queued" | "running" | "pausing" | "paused" | "failed" | "completed";

export interface ClassificationTask {
  readonly state: ClassificationTaskState;
  readonly completed: number;
  readonly total: number;
  /** A short host-sanitised task label. */
  readonly label?: string;
}

export interface ClassificationCoverage {
  readonly totalBooks: number;
  readonly incompleteBooks: number;
}

export interface ClassificationSettings {
  /** This only controls local filtering; generated tags remain separate from manual tags. */
  readonly useModelTags: boolean;
}

export interface ClassificationSnapshot {
  readonly task: ClassificationTask;
  readonly coverage: ClassificationCoverage;
  readonly settings: ClassificationSettings;
}

export interface ExperimentalOptions {
  readonly newsnowPrefetch: boolean;
  readonly newsnowHideReturnIcon: boolean;
}

/**
 * Legacy input is supplied only by a host adapter during a one-time migration.
 * The former `newsnow` master switch is deliberately ignored: News is now a
 * permanent entry, matching the legacy implementation.
 */
export interface ExperimentalOptionsCompatibilityInput {
  readonly newsnowPrefetch?: unknown;
  readonly newsnowHideReturnIcon?: unknown;
  readonly newsnow?: unknown;
}

export interface ExperimentalOptionsSnapshot {
  readonly options: ExperimentalOptions;
  /** True when the host should persist the normalised current-key shape. */
  readonly requiresCompatibilityWrite: boolean;
}

export interface GeneralSettingsPort {
  loadAutoImportSettings(signal: AbortSignal): Promise<AutoImportSettings>;
  saveAutoImportSettings(settings: AutoImportSettings, signal: AbortSignal): Promise<AutoImportSettings>;
  /** Returns null when the user dismisses the host directory picker. */
  chooseAutoImportDirectories(signal: AbortSignal): Promise<readonly AutoImportDirectory[] | null>;
  scanAutoImport(signal: AbortSignal): Promise<AutoImportScanResult>;
  subscribeAutoImportProgress(listener: (progress: AutoImportProgress) => void): () => void;

  loadClassification(signal: AbortSignal): Promise<ClassificationSnapshot>;
  startClassification(signal: AbortSignal): Promise<void>;
  saveClassificationSettings(settings: ClassificationSettings, signal: AbortSignal): Promise<ClassificationSettings>;

  loadExperimentalOptions(signal: AbortSignal): Promise<ExperimentalOptionsSnapshot>;
  saveExperimentalOptions(options: ExperimentalOptions, signal: AbortSignal): Promise<ExperimentalOptions>;
}
