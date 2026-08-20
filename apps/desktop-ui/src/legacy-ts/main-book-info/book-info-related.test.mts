import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";

import {
  installBookInfoRelated,
  type BookInfoRelatedGlobal,
} from "./book-info-related.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);

class FakeClassList {
  public readonly values = new Set<string>();
  public add(...values: string[]): void {
    values.forEach((value) => this.values.add(value));
  }
  public remove(...values: string[]): void {
    values.forEach((value) => this.values.delete(value));
  }
}

class FakeElement {
  public type = "";
  public className = "";
  public textContent = "";
  public src = "";
  public alt = "";
  public readonly classList = new FakeClassList();
  public readonly style: Record<string, string> = {};
  public readonly dataset: Record<string, string> = {};
  public readonly children: FakeElement[] = [];
  public readonly listeners = new Map<string, (event: Event) => void>();
  public parent: FakeElement | null = null;
  private html = "";

  public get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  public set innerHTML(value: string) {
    this.html = value;
    this.replaceChildren();
    if (value.includes('id="similar-books-modal"')) {
      const similar = new FakeElement();
      similar.dataset.bookRelated = "similar";
      const source = new FakeElement();
      source.dataset.bookRelatedSource = "";
      const close = new FakeElement();
      close.dataset.bookRelatedClose = "";
      const list = new FakeElement();
      list.dataset.bookRelatedSimilarList = "";
      similar.append(source, close, list);

      const timeline = new FakeElement();
      timeline.dataset.bookRelated = "timeline";
      const subtitle = new FakeElement();
      subtitle.dataset.bookRelatedTimelineSubtitle = "";
      subtitle.textContent = "从阅读时长到进度变化";
      const timelineClose = new FakeElement();
      timelineClose.dataset.bookRelatedClose = "";
      const body = new FakeElement();
      body.dataset.bookRelatedTimelineBody = "";
      timeline.append(subtitle, timelineClose, body);
      this.append(similar, timeline);
    }
  }

  public get innerHTML(): string {
    return this.html;
  }

  public append(...nodes: FakeElement[]): void {
    nodes.forEach((node) => this.appendChild(node));
  }

  public appendChild(node: FakeElement): FakeElement {
    node.parent?.removeChild(node);
    node.parent = this;
    this.children.push(node);
    return node;
  }

  public removeChild(node: FakeElement): void {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parent = null;
  }

  public replaceChildren(...nodes: FakeElement[]): void {
    this.children.forEach((node) => {
      node.parent = null;
    });
    this.children.splice(0, this.children.length);
    this.append(...nodes);
  }

  public addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (typeof listener === "function") this.listeners.set(type, listener);
  }

  public fire(type: string): void {
    this.listeners.get(type)?.({ target: this } as unknown as Event);
  }

  public querySelector(selector: string): FakeElement | null {
    return find(this, selector);
  }
}

function matches(element: FakeElement, selector: string): boolean {
  if (selector === '[data-book-related="similar"]') {
    return element.dataset.bookRelated === "similar";
  }
  if (selector === '[data-book-related="timeline"]') {
    return element.dataset.bookRelated === "timeline";
  }
  const attribute = selector.match(/^\[([\w-]+)\]$/u)?.[1];
  if (!attribute) return false;
  const key = attribute
    .replace(/^data-/u, "")
    .replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());
  return Object.hasOwn(element.dataset, key);
}

function find(root: FakeElement, selector: string): FakeElement | null {
  for (const child of root.children) {
    if (matches(child, selector)) return child;
    const nested = find(child, selector);
    if (nested) return nested;
  }
  return null;
}

function classicSource(): string {
  return execFileSync("git", ["show", "HEAD:ui/book-info-related.js"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

function fixture() {
  const body = new FakeElement();
  const document = {
    body,
    createElement: () => new FakeElement(),
    querySelector: (selector: string) => find(body, selector),
  } as unknown as Document;
  return { body, document };
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

async function exercise(legacy: boolean) {
  const view = fixture();
  const calls: Array<{
    readonly command: string;
    readonly args?: Record<string, unknown>;
  }> = [];
  const opened: unknown[] = [];
  const invoke = async <TResult,>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<TResult> => {
    calls.push(args ? { command, args } : { command });
    if (command === "similar_books") {
      return [
        {
          id: "2",
          title: "书<&>",
          author: "作者",
          description: "简介",
          score: 1.4,
          cover: "",
        },
      ] as TResult;
    }
    return {
      title: "历史<&>",
      buckets: [
        { day: 20260812, seconds: 60, words: 100 },
        { day: 20260812, seconds: 120, words: 200 },
        { day: 20260813, seconds: 3660, words: 300 },
      ],
      events: [
        { at: 1_700_000_000, chapter: 2, progress: 12.34 },
        { at: 1_700_000_100, chapter: 3, progress: 45.67 },
      ],
    } as TResult;
  };
  const target: Record<string, unknown> = {
    document: view.document,
    ReaderBookInfoPanel: { fmtWords: (value: unknown) => `${value}<>& words` },
  };
  target.window = target;
  let api: BookInfoRelatedGlobal;
  if (legacy) {
    vm.runInNewContext(classicSource(), target);
    api = target.ReaderBookInfoRelated as BookInfoRelatedGlobal;
  } else {
    api = installBookInfoRelated(target) as BookInfoRelatedGlobal;
  }
  const controller = api.mount({
    root: view.document,
    invoke,
    coverColor: () => "custom-color",
    onOpenBook: (book) => opened.push(plain(book)),
  });
  const configured = api.mount({ root: view.document, invoke });
  assert.equal(controller, configured);
  await controller.openSimilar(7, { title: "源书" });
  const similarModal = find(view.body, '[data-book-related="similar"]');
  const source = similarModal?.querySelector("[data-book-related-source]");
  const list = similarModal?.querySelector("[data-book-related-similar-list]");
  const similarItem = list?.children[0];
  similarItem?.fire("click");
  await controller.openTimeline(7);
  const timelineModal = find(view.body, '[data-book-related="timeline"]');
  const subtitle = timelineModal?.querySelector(
    "[data-book-related-timeline-subtitle]",
  );
  const timelineBody = timelineModal?.querySelector(
    "[data-book-related-timeline-body]",
  );
  const snapshot = {
    calls,
    apiKeys: Object.keys(api).sort(),
    controllerKeys: Object.keys(controller).sort(),
    frozen: Object.isFrozen(api),
    durations: [0, 59.9, 60, 3_600, 3_661, -1].map(api.formatDuration),
    modalCount: view.body.children.length,
    source: source?.textContent,
    similarShown: similarModal?.classList.values.has("show"),
    similarItem: similarItem
      ? {
          className: similarItem.className,
          coverClass: similarItem.children[0]?.className,
          coverBackground: similarItem.children[0]?.style.background,
          title: similarItem.children[1]?.children[0]?.textContent,
          meta: similarItem.children[1]?.children[1]?.textContent,
          description: similarItem.children[1]?.children[2]?.textContent,
          scoreWidth:
            similarItem.children[1]?.children.at(-1)?.children[0]?.style.width,
        }
      : null,
    opened,
    timelineShown: timelineModal?.classList.values.has("show"),
    subtitle: subtitle?.textContent,
    timeline: timelineBody?.innerHTML,
  };
  controller.closeAll();
  return {
    ...snapshot,
    closed:
      !similarModal?.classList.values.has("show") &&
      !timelineModal?.classList.values.has("show"),
  };
}

test("strict installer remains behavior-equivalent to the classic VM", async () => {
  assert.deepEqual(plain(await exercise(false)), plain(await exercise(true)));
});

test("typed transport preserves exact related-book command envelopes", async () => {
  const result = await exercise(false);
  assert.deepEqual(result.calls, [
    { command: "similar_books", args: { id: "7" } },
    { command: "book_reading_timeline", args: { id: "7" } },
  ]);
  assert.match(String(result.timeline), /&lt;&gt;&amp; words/u);
  assert.doesNotMatch(String(result.timeline), /历史<&>/u);
});

test("missing root or typed invocation fails with the original message", () => {
  const api = installBookInfoRelated({ document: fixture().document });
  assert.throws(
    () => api?.mount(),
    new Error("相关图书信息层需要 root 和 invoke。"),
  );
});
