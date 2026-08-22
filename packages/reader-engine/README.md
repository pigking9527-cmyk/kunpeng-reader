# `@kunpeng/reader-engine`

The type-safe boundary around the existing imperative EPUB/PDF reader. It is
not a visual component library and does not replace the reader's DOM, Canvas,
pagination, scrolling, selection, gesture, PDF.js, or EPUB rendering loops.

## Why this exists

The legacy reader exchanges many one-key objects through `postMessage`:

- `ui/reader.js` receives frame reports such as progress, navigation, gesture,
  search status, annotations, dictionary/AI selection intents, TTS and page
  cache data.
- `ui/reader-search-ui.js` and `ui/reader.js` send commands including page
  turns, search, navigation, layout settings, highlights and snapshots.
- `ui/reader-page-runtime.js` currently receives raw `e.data`; the shell-side
  legacy guard (`ui/reader-message.js`) validates only the frame-to-shell
  direction.

This package defines the incremental replacement envelope:

```ts
{
  protocol: "kunpeng-reader-engine",
  version: 1,
  action: "turn-page",
  payload: { direction: "forward" },
}
```

Only explicitly allowlisted actions and payload shapes are accepted. A caller
must also provide the exact expected `source`, an explicit allowlist of origins
and a byte limit. Wildcard and opaque origins are rejected. The parser is pure,
so it can be tested before it is wired into either legacy page.

## Boundary

`ReaderEnginePort` is the only interface a future reader shell should need:

- The imperative engine is mounted into a DOM host and handles render loops.
- The shell sends `ReaderShellCommand` messages and subscribes to
  `ReaderFrameEvent` messages.
- Surrounding controls must not own pagination,
  scrolling, selection, gestures, EPUB layout or PDF rendering state.

Selected text is bounded and transient for dictionary/search/annotation/AI
intents. It must not be included in logs or fixtures. This package contains
only synthetic messages; it never includes book bodies, local paths, user
credentials or server information.

## Validation

The root `npm run typecheck` includes `src/`. To run the self-contained runtime
tests without adding a test framework, compile into a disposable directory and
run the generated module:

```sh
./node_modules/.bin/tsc -p packages/reader-engine/tsconfig.test.json --outDir /tmp/kunpeng-reader-engine-test
node /tmp/kunpeng-reader-engine-test/test/protocol.test.mjs
```

The test covers acceptance, forged source/origin rejection, unknown
version/action rejection and payload-size rejection.
