# Vendored epub patch

- Upstream crate: `epub` 2.1.5.
- Source: https://crates.io/crates/epub/2.1.5
- Local change: replace the `zip` 3.x dependency with `zip` 8.6 and enable only the zlib-rs Deflate backend.
- Source code changes: none.
- Compatibility check: upstream unit, integration, and documentation tests pass with the dependency change.

Remove this vendor copy and restore `epub = "2"` when an upstream `epub` release supports the current `zip` major version.
