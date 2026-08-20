# `@kunpeng/pdf-engine`

This is the TypeScript boundary around the existing imperative PDF.js reader.
It is not a visual component and does not replace the PDF.js canvas, text layer,
scrolling, selection, highlights, search loop, or PDF iframe.

## Boundary

`PdfRendererPort` is the interface the reader shell may consume. The current
production bridge is `apps/desktop-ui/src/pdf-engine-legacy-adapter.ts`, which
is bundled into `ui/bridge/pdf-engine-legacy-adapter.js` and called by
the existing `ui/pdfview.js`; this package does not replace the PDF surface.
`createPdfRendererPort` implements its lifecycle (`idle` → `loading`
→ `ready` → `rendering` → `failed` or `disposed`) around a trusted resolver,
PDF.js loader and imperative surface adapter. It uses `AbortSignal` plus
`cancel(operationId)`, destroys a loading task on cancellation/close, and emits
only typed lifecycle, completion, cancellation, and structured-error events.
Its read-only `diagnostics` snapshot exposes only bounded ownership counts and
booleans (never PDF bytes, paths, URLs, or page text) so tests can prove that
cancel, close, and dispose release renderer-owned references.

The controlled message protocol uses envelopes with a fixed protocol name and
version. Every document operation includes a bounded opaque `documentId` and,
where relevant, an `operationId`. The IDs intentionally reject paths, URL
syntax, query strings, fragments and whitespace. Renderer errors are code-only
so raw PDF.js errors, file names, paths and document content cannot cross the
reader-shell boundary.

`PdfDocumentResolver` turns an approved opaque ID into bytes. In turn,
`createPdfJsLoadParameters` creates PDF.js parameters from `Uint8Array` only:
there is deliberately no `url`, arbitrary range endpoint, or stream endpoint.
PDF.js remains in an imperative adapter that implements `PdfRendererPort`.

Messages must be checked with `parsePdfRendererCommand` or
`parsePdfRendererEvent`; frame use additionally calls the corresponding
`validate…Event` helper with the exact source and explicit origins. Unknown
actions, unknown fields, oversized messages, wildcard/opaque origins, URLs and
local paths are rejected.

The package contains only synthetic test data. Never add real books, paths,
credentials, server data, or reading content to its tests.

## Validation

The root typecheck includes this package. The protocol test is framework-free:

```sh
./node_modules/.bin/tsc -p packages/pdf-engine/tsconfig.test.json --outDir /tmp/kunpeng-pdf-engine-test
node /tmp/kunpeng-pdf-engine-test/test/protocol.test.mjs
```
