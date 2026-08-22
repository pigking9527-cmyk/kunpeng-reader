import {
  createWindowControls,
  type TauriTransport,
  type WindowResizeDirection,
} from "../src/index.js";

declare function expectType<TExpected>(value: TExpected): void;

const transport: TauriTransport = {
  invoke: async <TResult>() => undefined as TResult,
};

const controls = createWindowControls(transport);

expectType<Promise<void>>(controls.show());
expectType<Promise<void>>(controls.minimize());
expectType<Promise<void>>(controls.toggleMaximize());
expectType<Promise<void>>(controls.close());
expectType<Promise<void>>(controls.startDragging());
expectType<Promise<void>>(controls.startResizeDragging("north-east"));
expectType<Promise<boolean>>(controls.isReaderWindowOpen());
expectType<Promise<number>>(controls.elapsedSinceProcessStartMs());

const direction: WindowResizeDirection = "south-west";
expectType<Promise<void>>(controls.startResizeDragging(direction));

// @ts-expect-error Rust accepts only its eight explicit resize directions.
controls.startResizeDragging("left");
// @ts-expect-error Window controls deliberately do not expose arbitrary commands.
controls.invoke("open_book");
