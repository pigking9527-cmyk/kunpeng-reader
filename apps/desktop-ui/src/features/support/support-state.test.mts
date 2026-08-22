import assert from "node:assert/strict";
import test from "node:test";
import {
  createFeedbackDraft,
  feedbackFileSelectionMessage,
  isAbortError,
  maximumFeedbackImageBytes,
  operationFailureState,
  selectFeedbackImages,
} from "./support-state.ts";

function file(name: string, type: string, size: number): Pick<File, "name" | "type" | "size"> {
  return { name, type, size };
}

test("feedback screenshot selection reads only metadata and enforces type, size, and count", () => {
  const selection = selectFeedbackImages([
    file("ok.jpg", "image/jpeg", 100),
    file("bad.gif", "image/gif", 100),
    file("large.png", "image/png", maximumFeedbackImageBytes + 1),
    file("ok.webp", "image/webp", 100),
  ], 2);
  assert.deepEqual(selection.accepted.map((item) => item.name), ["ok.jpg"]);
  assert.equal(selection.rejectedUnsupported, 1);
  assert.equal(selection.rejectedOversized, 1);
  assert.equal(selection.rejectedOverLimit, 1);
  assert.match(feedbackFileSelectionMessage(selection), /格式、大小或数量限制/);
});

test("feedback selection gives a fixed, useful error without exposing a local file name", () => {
  const selection = selectFeedbackImages([file("private-screen.gif", "image/gif", 10)], 0);
  assert.equal(feedbackFileSelectionMessage(selection), "截图仅支持 JPEG、PNG 或 WebP 格式。");
  assert.doesNotMatch(feedbackFileSelectionMessage(selection), /private-screen/);
});

test("drafts preserve opaque attachment ids and keep feature feedback free of diagnostic traces", () => {
  assert.deepEqual(createFeedbackDraft("bug", "x", ["image-1"], "trace-1"), {
    kind: "bug", text: "x", imageAttachmentIds: ["image-1"], diagnosticAttachmentId: "trace-1",
  });
  assert.deepEqual(createFeedbackDraft("feature", "x", ["image-1"]), {
    kind: "feature", text: "x", imageAttachmentIds: ["image-1"],
  });
});

test("cancel and failure paths use generic UI copy even for non-Error abort values", () => {
  assert.equal(isAbortError({ name: "AbortError", internal: "do-not-display" }), true);
  assert.equal(operationFailureState().label, "操作未完成，请稍后重试。");
});
