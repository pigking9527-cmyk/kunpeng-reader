import {
  createTauriApi,
  type TauriEvent,
  type TauriTransport,
} from "../src/index.js";

type WindowCommands = {
  main_window_show: { result: void };
  startup_elapsed_ms: { result: number };
  main_window_start_resize_dragging: {
    args: {
      direction:
        | "north"
        | "north-east"
        | "east"
        | "south-east"
        | "south"
        | "south-west"
        | "west"
        | "north-west";
    };
    result: void;
  };
};

type WindowEvents = {
  "reader-window-trace": { phase: string; outcome: string; durationMs: number };
};

declare function expectType<TExpected>(value: TExpected): void;

const transport: TauriTransport = {
  invoke: async <TResult>() => undefined as TResult,
  listen: async () => () => {},
  emit: async () => {},
};

const api = createTauriApi<WindowCommands>(transport);

expectType<Promise<void>>(api.invoke("main_window_show"));
expectType<Promise<number>>(api.invoke("startup_elapsed_ms"));
expectType<Promise<void>>(
  api.invoke("main_window_start_resize_dragging", { direction: "east" }),
);

// @ts-expect-error Commands without a declared argument must not receive one.
api.invoke("main_window_show", { ignored: true });
// @ts-expect-error A declared command argument is required.
api.invoke("main_window_start_resize_dragging");
// @ts-expect-error A feature can only call commands it has explicitly declared.
api.invoke("open_book");

const events = api.events<WindowEvents>();
events.listen("reader-window-trace", (event) => {
  expectType<TauriEvent<WindowEvents["reader-window-trace"]>>(event);
  expectType<string>(event.payload.phase);
});
// @ts-expect-error Undeclared events cannot be emitted from this feature.
events.emit("sync-status", { state: "running" });
