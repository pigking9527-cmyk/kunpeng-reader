import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  installBookInfoPanel,
  type BookInfoController,
  type BookInfoPanelApi,
} from "./book-info-panel.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);

function classicSource(): string {
  try {
    return readFileSync(new URL("ui/book-info-panel.js", repositoryRoot), "utf8");
  } catch {
    return execFileSync("git", ["show", "HEAD:ui/book-info-panel.js"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
  }
}

class FakeClassList {
  public readonly values = new Set<string>();
  public add(value: string): void {
    this.values.add(value);
  }
}

interface FakeEvent {
  readonly target: FakeElement;
  readonly clientX: number;
}

class FakeElement {
  public readonly classList = new FakeClassList();
  public readonly dataset: Record<string, string> = {};
  public readonly children: FakeElement[] = [];
  public readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  public readonly style: Record<string, string> = {};
  public className = "";
  public textContent = "";
  public title = "";
  public value = "";
  public innerHTML = "";
  public src = "";
  public alt = "";
  public draggable = true;
  public decoding = "";
  public _value?: number;

  public constructor(
    public readonly tagName: string,
    public readonly id = "",
  ) {}

  public append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  public appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  public replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  public addEventListener(
    type: string,
    listener: (event: FakeEvent) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  public fire(type: string, clientX = 0, target: FakeElement = this): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ target, clientX });
    }
  }

  public querySelector(selector: string): FakeElement | null {
    if (selector === ".s-fg") return this.children.find(({ className }) => className === "s-fg") ?? null;
    return null;
  }

  public getBoundingClientRect(): DOMRect {
    const parentIndex = this.id.startsWith("star-") ? Number(this.id.slice(5)) : 0;
    const left = parentIndex * 20;
    return {
      x: left,
      y: 0,
      left,
      right: left + 20,
      top: 0,
      bottom: 20,
      width: 20,
      height: 20,
      toJSON: () => ({}),
    };
  }

  public closest(selector: string): FakeElement | null {
    return selector === "[data-book-info-action]" && this.dataset.bookInfoAction ? this : null;
  }
}

function fixture() {
  const elements = new Map<string, FakeElement>();
  let starIndex = 0;
  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (tagName: string) => {
      const id = tagName === "span" && starIndex < 5 ? `star-${starIndex++}` : "";
      return new FakeElement(tagName, id);
    },
    createTextNode: (text: string) => {
      const node = new FakeElement("#text");
      node.textContent = text;
      return node;
    },
  };
  const target: Record<string, unknown> = { document };
  target.window = target;
  target.globalThis = target;
  const host = new FakeElement("div", "host");
  const prefix = "spec";
  const ids = {
    cover: `${prefix}-cover`,
    title: `${prefix}-title`,
    author: `${prefix}-author`,
    format: `${prefix}-format`,
    words: `${prefix}-words`,
    size: `${prefix}-size`,
    stars: `${prefix}-stars`,
    tagSummary: `${prefix}-tag-summary`,
    collectionSummary: `${prefix}-collection-summary`,
    modelTags: `${prefix}-model-tags`,
    description: `${prefix}-desc`,
    coverChange: `${prefix}-cover-change`,
    tagsManage: `${prefix}-tags-manage`,
    collectionsManage: `${prefix}-collections-manage`,
    similar: `${prefix}-similar-books-btn`,
    timeline: `${prefix}-reading-timeline-btn`,
  };
  for (const [key, id] of Object.entries(ids)) {
    elements.set(id, new FakeElement(key === "title" ? "input" : "div", id));
  }
  return { target, document, elements, host, prefix, ids };
}

function snapshot(view: ReturnType<typeof fixture>, controller: BookInfoController): unknown {
  const elementState = Object.fromEntries(
    Object.entries(view.ids).map(([key, id]) => {
      const element = view.elements.get(id);
      return [
        key,
        {
          text: element?.textContent,
          title: element?.title,
          value: element?.value,
          children: element?.children.map((child) => ({
            tag: child.tagName,
            className: child.className,
            text: child.textContent,
            title: child.title,
            src: child.src,
            alt: child.alt,
            draggable: child.draggable,
            decoding: child.decoding,
            background: child.style.background,
            children: child.children.map((nested) => ({
              className: nested.className,
              text: nested.textContent,
            })),
          })),
        },
      ];
    }),
  );
  return {
    markup: view.host.innerHTML,
    elementState,
    rating: controller.elements.stars._value,
    starWidths: Array.from(controller.elements.stars.children).map(
      (star) => (star as HTMLElement).querySelector<HTMLElement>(".s-fg")?.style.width,
    ),
  };
}

function exercise(legacy: boolean) {
  const view = fixture();
  if (legacy) vm.runInNewContext(classicSource(), view.target);
  else installBookInfoPanel(view.target);
  const api = view.target.ReaderBookInfoPanel as BookInfoPanelApi;
  const events = {
    ratings: [] as number[],
    titles: [] as string[],
    descriptions: [] as string[],
    actions: [] as string[],
  };
  const controller = api.mount({
    root: view.document as unknown as Document,
    host: view.host as unknown as HTMLElement,
    prefix: view.prefix,
    onRating: (rating) => events.ratings.push(rating),
    onTitle: (title) => events.titles.push(title),
    onDescription: (description) => events.descriptions.push(description),
    onAction: (action) => events.actions.push(action),
  });
  const sameController = api.mount({
    root: view.document as unknown as Document,
    host: view.host as unknown as HTMLElement,
    prefix: "ignored",
  });
  controller.render({
    title: "长夜",
    author: "某作者",
    format: "epub",
    word_count: 23_456,
    size: 1_572_864,
    description: "  原简介  ",
    tags: ["历史", "", "文学"],
    collections: [],
    model_tags: ["叙事", "现代"],
    rating: 3.5,
    cover: "https://example.test/cover.jpg",
  });
  const rendered = snapshot(view, controller);
  const stars = controller.elements.stars as unknown as FakeElement;
  stars.fire("mousemove", 7);
  const hovered = Array.from(controller.elements.stars.children).map(
    (star) => (star as HTMLElement).querySelector<HTMLElement>(".s-fg")?.style.width,
  );
  stars.fire("mouseleave");
  stars.fire("click", 70);
  controller.elements.title.value = "  新书名  ";
  (controller.elements.title as unknown as FakeElement).fire("blur");
  controller.elements.description.textContent = "  新简介  ";
  (controller.elements.description as unknown as FakeElement).fire("blur");
  const action = new FakeElement("button");
  action.dataset.bookInfoAction = "timeline";
  view.host.fire("click", 0, action);
  controller.render({ title: "无封面", tags: null, modelTags: [] });
  const fallback = snapshot(view, controller);
  controller.setLoading();
  const loading = controller.elements.words.textContent;
  controller.setError("bad");
  const error = controller.elements.words.textContent;
  return {
    api: { keys: Object.keys(api).sort(), frozen: Object.isFrozen(api) },
    formats: [api.fmtWords(0), api.fmtWords(12_345), api.fmtSize(10), api.fmtSize(2_048), api.fmtSize(1_572_864)],
    sameController: sameController === controller,
    controllerKeys: Object.keys(controller).sort(),
    rendered,
    hovered,
    events,
    fallback,
    loading,
    error,
  };
}

test("book info panel strict installer is behavior-equivalent to classic VM", () => {
  assert.equal(JSON.stringify(exercise(false)), JSON.stringify(exercise(true)));
});

test("book info panel preserves its frozen global, rendering and interaction contract", () => {
  const result = exercise(false);
  assert.deepEqual(result.api, { keys: ["fmtSize", "fmtWords", "mount"], frozen: true });
  assert.deepEqual(result.formats, ["0 字", "1.23 万字", "10B", "2K", "1.5M"]);
  assert.equal(result.sameController, true);
  assert.deepEqual(result.events, {
    ratings: [2],
    titles: ["新书名"],
    descriptions: ["新简介"],
    actions: ["timeline"],
  });
  assert.equal(result.loading, "统计中…");
  assert.equal(result.error, "读取失败：bad");
  const rendered = result.rendered as {
    readonly elementState: Record<string, { readonly text: string; readonly value: string }>;
    readonly rating: number;
  };
  assert.equal(rendered.elementState.title?.value, "长夜");
  assert.equal(rendered.elementState.words?.text, "2.35 万字");
  assert.equal(rendered.elementState.size?.text, "1.5M");
  assert.equal(rendered.rating, 3.5);
});

test("book info panel installer fails closed without the original document runtime", () => {
  assert.equal(installBookInfoPanel({}), null);
});
