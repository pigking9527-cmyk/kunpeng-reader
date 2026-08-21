import type { TauriTransport } from "../../../../../packages/tauri-api/src/index.js";
import {
  createWindowSettingsTauriPort,
  type StartupEnhancementStatePayload,
  type WindowSettingsNativeApi,
} from "./window-settings-tauri-adapter.js";

declare function expectType<TExpected>(value: TExpected): void;
declare const transport: TauriTransport;
declare const signal: AbortSignal;

const port: WindowSettingsNativeApi = createWindowSettingsTauriPort(transport);

expectType<Promise<void>>(port.closeMainWindow(signal));
expectType<Promise<void>>(port.requestApplicationExit(signal));
expectType<Promise<() => void>>(
  port.listenStartupEnhancementState((event) => {
    expectType<StartupEnhancementStatePayload>(event.payload);
    expectType<number>(event.payload.highCostResumeAtMs);
  }, signal),
);

// @ts-expect-error The feature port intentionally hides raw Tauri command names.
port.invoke("main_window_exit");
