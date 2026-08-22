import assert from "node:assert/strict";
import test from "node:test";

import { computeLevels, normalizeRole, ROLE_BASE } from "./overlay-stack.ts";

test("overlay levels retain semantic bands and opening order", () => {
  assert.deepEqual(
    computeLevels([
      { role: "information", order: 4 },
      { role: "operation", order: 2 },
      { role: "critical", order: 1 },
      { role: "feedback", order: 1 },
    ]),
    [ROLE_BASE.information + 1, ROLE_BASE.operation, ROLE_BASE.critical, ROLE_BASE.feedback],
  );
});

test("unknown overlay roles keep the legacy operation fallback", () => {
  assert.equal(normalizeRole("unknown"), "operation");
  assert.equal(normalizeRole(null), "operation");
});
