/**
 * The only data and command boundary for shelf integration.
 *
 * A host maps the legacy book DTOs and native commands to these view models.
 * This deliberately does not prescribe persistence, sync entities, or Tauri
 * command names: those remain outside the feature and keep their existing
 * contracts.
 */
export type ShelfBookId = string;

export interface ShelfBook {
  readonly id: ShelfBookId;
  readonly title: string;
  readonly author?: string;
  readonly description?: string;
  readonly coverUrl?: string;
  readonly rating?: number;
  /** 0–1 progress supplied by the host; absent means no saved reading state. */
  readonly progress?: number;
  readonly addedAt?: number;
  readonly lastReadAt?: number;
  readonly readingSeconds?: number;
  readonly fileSizeBytes?: number;
  readonly tags: readonly string[];
  readonly collections: readonly string[];
}

export interface ShelfBooklist {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly bookIds: readonly ShelfBookId[];
  readonly coverBookId?: ShelfBookId;
  /** Per-book editorial note, never book text or a local path. */
  readonly reviews?: Readonly<Record<ShelfBookId, string>>;
}

export interface ShelfSnapshot {
  readonly books: readonly ShelfBook[];
  readonly booklists: readonly ShelfBooklist[];
}

export type ShelfOrganizationKind = "tag" | "collection";

export interface AddShelfOrganizationRequest {
  readonly bookIds: readonly ShelfBookId[];
  readonly kind: ShelfOrganizationKind;
  readonly names: readonly string[];
}

export interface SaveShelfBooklistRequest {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly bookIds: readonly ShelfBookId[];
  readonly coverBookId?: ShelfBookId;
  readonly reviews: Readonly<Record<ShelfBookId, string>>;
}

export interface ShelfPort {
  load(signal: AbortSignal): Promise<ShelfSnapshot>;
  openBook(bookId: ShelfBookId, signal: AbortSignal): Promise<void>;
  /** Additive only: implementations must not replace existing membership. */
  addOrganization(request: AddShelfOrganizationRequest, signal: AbortSignal): Promise<ShelfSnapshot>;
  /** Saves an existing host-provided booklist without changing its identity. */
  saveBooklist(request: SaveShelfBooklistRequest, signal: AbortSignal): Promise<ShelfSnapshot>;
  /** Creates an empty named booklist through the host's existing sync-aware path. */
  createBooklist(name: string, signal: AbortSignal): Promise<ShelfSnapshot>;
  /** Removes only the named booklist and its membership relations, never books. */
  deleteBooklist(id: string, signal: AbortSignal): Promise<ShelfSnapshot>;
  /** Removes books from the local shelf only; source files remain untouched. */
  removeBooks(bookIds: readonly ShelfBookId[], signal: AbortSignal): Promise<ShelfSnapshot>;
}
