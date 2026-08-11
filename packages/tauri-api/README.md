# `@kunpeng/tauri-api`

This package is the frontend adapter boundary for Tauri commands and events.
It is deliberately small: it does **not** attempt to describe every existing
Rust command. The legacy UI has many untyped `window.__TAURI__` calls, and a
central map guessed from those call sites would silently turn guesses into an
API contract.

## Use in a new or migrated feature

At the window composition root, obtain a transport once:

```ts
import { createTauriApi, transportFromTauriGlobal } from "@kunpeng/tauri-api";

type SettingsCommands = {
  app_version: { result: string };
  set_feature_enabled: { args: { enabled: boolean }; result: void };
};

const api = createTauriApi<SettingsCommands>(transportFromTauriGlobal());
```

Pass `api` (or a narrower feature service built on it) into the application layer.
Unit tests pass a `TauriTransport` fake instead; neither tests nor components
need `window.__TAURI__`.

Before adding a command or event to a feature map, verify its Rust `#[tauri::command]`
signature, serde field names, return value, and error behaviour. Shared sync
entities and API semantics still come from `contracts/`, not from this package.

## Incremental migration

1. Leave the existing JavaScript call site working.
2. Move one feature's new TypeScript use case behind `createTauriApi`.
3. Add only that feature's audited command/event map beside the feature.
4. Add a fake transport to its unit test, then replace the old call site after
   behaviour tests pass.

`test/type-contracts.ts` is a compile-time regression test. The root strict
TypeScript check must include `packages/**/*.ts`; it verifies command argument,
return, and event payload inference without needing a WebView or a Tauri npm
dependency.

## Window controls

`createWindowControls(transport)` is the first concrete feature adapter. It
wraps only the Rust commands audited in `src/window_commands.rs` and
`src/app_commands.rs`: main-window show/minimize/maximize/close/drag/resize,
the reader-window-open query, and startup elapsed time. It does not change
window behaviour or connect any legacy UI; a future feature can call its
named methods instead of sending raw command strings.

## Window settings feature adapter

The window-settings integration has its own concrete adapter at
`apps/desktop-ui/src/adapters/window-settings/`. Its composition root follows
this pattern:

```ts
const transport = transportFromTauriGlobal();
const port = createWindowSettingsTauriPort(transport);
```

`createWindowSettingsTauriPort` is intentionally passed a transport; it never
reads a browser global. Its audited map contains only
`startup_enhancement_config`, `set_startup_enhancement_config({ request })`,
`main_window_close`, `main_window_exit`, and the
`startup-enhancement-state` event. It validates native payloads and converts
unknown Tauri rejections to a command-specific `WindowSettingsTauriError`.
The future legacy-bridge integration must construct the transport once and
inject this port rather than duplicating raw `invoke` calls.
