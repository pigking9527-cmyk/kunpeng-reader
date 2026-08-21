# `@kunpeng/test-utils`

Framework-neutral test helpers for new TypeScript desktop features. This
package never opens a Tauri WebView and does not access `window.__TAURI__`.

```ts
import { abortable, FakeTauriTransport } from "@kunpeng/test-utils";

const tauri = new FakeTauriTransport();
tauri.queueInvokeResult("sync_status", { phase: "idle" });

const status = await tauri.invoke<{ phase: string }>("sync_status");

const pending = tauri.queueDeferred<void>("sync_now");
const controller = new AbortController();
const visibleRequest = abortable(tauri.invoke<void>("sync_now"), controller.signal);
controller.abort(); // feature observes AbortError; native work may complete later
pending.resolve();
```

- `FakeTauriTransport` records invokes and emitted events, queues outcomes and
  can dispatch events to registered listeners.
- `createDeferred` models an operation that is still in flight.
- `abortable` models the UI cancellation boundary; it intentionally does not
  falsely claim to cancel work in Rust.

These are production-test utilities, not an application dependency. New
features should receive a `TauriTransport` through their composition root and
use this fake in their unit tests.
