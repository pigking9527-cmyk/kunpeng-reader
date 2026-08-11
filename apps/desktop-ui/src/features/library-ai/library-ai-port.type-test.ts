import type {
  LibraryAiBook,
  LibraryAiPort,
  LibraryAiSource,
  SemanticStatus,
} from "./library-ai-port.js";

declare function expectType<TExpected>(value: TExpected): void;

declare const port: LibraryAiPort;
declare const controller: AbortController;
declare const source: LibraryAiSource;
declare const book: LibraryAiBook;
declare const semantic: SemanticStatus;

expectType<Promise<void>>(port.cancelQuery());
expectType<Promise<void>>(port.openSource(source.bookId, source.chapter, controller.signal));
expectType<string>(source.bookTitle);
expectType<boolean>(book.available);
expectType<boolean>(semantic.indexReady);

// @ts-expect-error Feature source state must never contain an excerpt/body.
expectType<never>(source.body);
// @ts-expect-error Local paths never cross the feature port.
expectType<never>(book.path);
// @ts-expect-error Model keys belong only to the native adapter/configuration surface.
expectType<never>(semantic.apiKey);
// @ts-expect-error A query must use one of the supported task kinds.
port.ask({ task: "summarize", question: "x", selectedBookIds: [] }, controller.signal, () => undefined);
