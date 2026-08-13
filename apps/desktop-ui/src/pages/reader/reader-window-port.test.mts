import assert from "node:assert/strict";
import test from "node:test";
import { createTauriReaderWindowPort } from "./reader-window-port.ts";

test("reader window port exposes only a validated reader resource and native close", async () => {
  const calls: string[] = [];
  const port = createTauriReaderWindowPort({
    invoke: async <TResult,>(command: string): Promise<TResult> => {
      calls.push(command);
      if (command === "book_info") {
        return {
          id: "42", content_id: "content-42", title: "测试图书", format: "epub",
          url: "reader://localhost/book/42", resume_chapter: 3, resume_frac: 0.25,
        } as TResult;
      }
      return undefined as TResult;
    },
  });
  const controller = new AbortController();
  assert.deepEqual(await port.loadBook(controller.signal), {
    id: "42", contentId: "content-42", title: "测试图书", format: "epub",
    resourceUrl: "reader://localhost/book/42", resumeChapter: 3, resumeFraction: 0.25,
  });
  await port.close(controller.signal);
  assert.deepEqual(calls, ["book_info", "main_window_close"]);
});

test("reader window port rejects paths and public URLs returned by an invalid host", async () => {
  const port = createTauriReaderWindowPort({
    invoke: async <TResult,>(): Promise<TResult> => ({
      id: "42", title: "测试图书", format: "pdf", url: "file:///private/book.pdf", resume_chapter: 0, resume_frac: 0,
    } as TResult),
  });
  await assert.rejects(port.loadBook(new AbortController().signal), /resource is unavailable/);
});
