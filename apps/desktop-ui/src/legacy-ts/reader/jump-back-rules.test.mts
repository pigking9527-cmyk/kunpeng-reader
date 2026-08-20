import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeReaderJumpBackIconSize,
  normalizeReaderJumpBackPosition,
  readerJumpBackIconHeight,
  readerJumpBackTrackPoint,
} from "./jump-back-rules.ts";

test("jump-back settings preserve v5 pixel and normalized position bounds", () => {
  assert.equal(normalizeReaderJumpBackPosition(-1, 500), 0);
  assert.equal(normalizeReaderJumpBackPosition(1001, 500), 1000);
  assert.equal(normalizeReaderJumpBackPosition("invalid", 499.6), 500);
  assert.equal(normalizeReaderJumpBackIconSize(12), 30);
  assert.equal(normalizeReaderJumpBackIconSize(200), 160);
  assert.equal(normalizeReaderJumpBackIconSize(undefined), 32);
});

test("jump-back icon geometry matches the classic visible-track calculation", () => {
  assert.equal(readerJumpBackIconHeight(30), 12);
  assert.equal(readerJumpBackIconHeight(100), 40);
  assert.equal(readerJumpBackTrackPoint(1000, 40, 60, 500), 470);
  assert.equal(readerJumpBackTrackPoint(20, 40, 60, 1000), -10);
});
