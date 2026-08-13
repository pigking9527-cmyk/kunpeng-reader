import assert from "node:assert/strict";
import test from "node:test";
import { createReaderWindowController } from "./reader-window-controller.ts";
import type { ReaderBookInfo, ReaderWindowPort } from "./reader-window-port.ts";

const book: ReaderBookInfo = {
  id: "42",
  contentId: "content-42",
  title: "测试图书",
  format: "epub",
  resourceUrl: "reader://localhost/book/42",
  resumeChapter: 2,
  resumeFraction: 0.4,
};

test("reader window loads typed book metadata and clears it on close", async () => {
  const calls: string[] = [];
  const port: ReaderWindowPort = {
    loadBook: async () => book,
    close: async () => { calls.push("close"); },
  };
  const controller = createReaderWindowController(port);
  await controller.load();
  assert.deepEqual(controller.getState(), { phase: "ready", book, notice: null });
  await controller.close();
  assert.deepEqual(controller.getState(), { phase: "closed", book: null, notice: null });
  assert.deepEqual(calls, ["close"]);
});

test("reader window suppresses load results after disposal", async () => {
  let resolveBook: (value: ReaderBookInfo) => void = () => {
    throw new Error("load request was not created");
  };
  const port: ReaderWindowPort = {
    loadBook: () => new Promise((done: (value: ReaderBookInfo) => void) => { resolveBook = done; }),
    close: async () => undefined,
  };
  const controller = createReaderWindowController(port);
  const pending = controller.load();
  controller.dispose();
  resolveBook(book);
  await pending;
  assert.deepEqual(controller.getState(), { phase: "closed", book: null, notice: null });
});
