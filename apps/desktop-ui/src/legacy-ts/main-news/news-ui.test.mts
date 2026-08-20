import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";

import { installNewsUi } from "./news-ui.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);

function legacyNewsUi(): Record<string, unknown> {
  class FakeDocument {
    public getElementById(): null {
      return null;
    }
    public querySelector(): null {
      return null;
    }
  }
  const context: Record<string, unknown> = {
    Document: FakeDocument,
    document: new FakeDocument(),
    URL,
    Intl,
    Promise,
    setTimeout,
    clearTimeout,
  };
  context.window = context;
  vm.runInNewContext(
    execFileSync("git", ["show", "HEAD:ui/news-ui.js"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }),
    context,
    { filename: "news-ui.js" },
  );
  return context.ReaderNewsUI as Record<string, unknown>;
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

test("strict news installer preserves classic public pure APIs", () => {
  class FakeDocument {
    public getElementById(): null {
      return null;
    }
    public querySelector(): null {
      return null;
    }
  }
  const originalDocument = globalThis.Document;
  Object.defineProperty(globalThis, "Document", {
    configurable: true,
    value: FakeDocument,
  });
  try {
    const modern = installNewsUi({ document: new FakeDocument() }) as unknown as Record<string, unknown>;
    const legacy = legacyNewsUi();
    const modernItems = modern.resultItems as (value: unknown) => unknown;
    const legacyItems = legacy.resultItems as (value: unknown) => unknown;
    const modernUrl = modern.safeHttpUrl as (value: unknown) => string;
    const legacyUrl = legacy.safeHttpUrl as (value: unknown) => string;
    const modernSources = modern.allowedSourceIds as (ids: unknown, catalog: unknown) => unknown;
    const legacySources = legacy.allowedSourceIds as (ids: unknown, catalog: unknown) => unknown;
    const catalog = [
      { id: "one", defaultEnabled: true },
      { id: "two", default_enabled: true },
      { id: "three", defaultEnabled: false },
    ];
    for (const result of [
      null,
      [],
      [{ url: "https://example.com/a" }],
      { items: [{ url: "https://example.com/a" }] },
      { data: [{ href: "http://example.com/no" }] },
      { news: [{ link: "https://example.com/b", preview_attempted: true }] },
    ]) {
      assert.deepEqual(plain(modernItems(result)), plain(legacyItems(result)));
    }
    for (const value of [
      "https://example.com/path",
      "http://example.com/path",
      "javascript:alert(1)",
      "not a url",
      null,
    ]) {
      assert.equal(modernUrl(value), legacyUrl(value));
    }
    assert.deepEqual(
      plain(modernSources(["two", "bad", "two", "one"], catalog)),
      plain(legacySources(["two", "bad", "two", "one"], catalog)),
    );
  } finally {
    Object.defineProperty(globalThis, "Document", {
      configurable: true,
      value: originalDocument,
    });
  }
});
