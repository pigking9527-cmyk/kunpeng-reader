import assert from "node:assert/strict";
import test from "node:test";

import {
  installReaderPageModeSwitch,
  type ReaderPageModeSwitchRuntime,
  type ReaderSourceTextRecord,
} from "./reader-page-mode-switch.ts";

interface RectShape {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

const zeroRect = (): RectShape => ({
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
  width: 0,
  height: 0,
});

class FakeClassList {
  readonly values = new Set<string>();

  add(value: string): void {
    this.values.add(value);
  }

  remove(value: string): void {
    this.values.delete(value);
  }

  contains(value: string): boolean {
    return this.values.has(value);
  }
}

class FakeNode {
  parentNode: FakeNode | null = null;
  readonly children: FakeNode[] = [];
  rect: RectShape = zeroRect();

  constructor(
    readonly nodeType: number,
    public nodeValue: string | null,
  ) {}

  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }

  get nextSibling(): FakeNode | null {
    if (!this.parentNode) return null;
    const index = this.parentNode.children.indexOf(this);
    return index < 0 ? null : this.parentNode.children[index + 1] ?? null;
  }

  appendChild(child: FakeNode): FakeNode {
    child.detach();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child: FakeNode, reference: FakeNode | null): FakeNode {
    child.detach();
    child.parentNode = this;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  detach(): void {
    this.parentNode?.removeChild(this);
  }

  cloneNode(): FakeNode {
    return new FakeNode(this.nodeType, this.nodeValue);
  }

  normalize(): void {
    for (let index = this.children.length - 1; index > 0; index -= 1) {
      const current = this.children[index];
      const previous = this.children[index - 1];
      if (current?.nodeType === 3 && previous?.nodeType === 3) {
        previous.nodeValue = `${previous.nodeValue ?? ""}${current.nodeValue ?? ""}`;
        this.removeChild(current);
      }
    }
    for (const child of this.children) child.normalize();
  }
}

class FakeText extends FakeNode {
  constructor(value: string) {
    super(3, value);
  }

  override cloneNode(): FakeText {
    return new FakeText(this.nodeValue ?? "");
  }

  splitText(offset: number): FakeText {
    const value = this.nodeValue ?? "";
    const tail = new FakeText(value.slice(offset));
    this.nodeValue = value.slice(0, offset);
    if (this.parentNode) this.parentNode.insertBefore(tail, this.nextSibling);
    return tail;
  }
}

class FakeElement extends FakeNode {
  readonly classList = new FakeClassList();
  readonly attributes = new Map<string, string>();
  readonly style = { height: "", cssText: "" };
  __rrModeSwitchSpacer?: FakeElement;
  clientHeight = 0;
  followingTarget: FakeNode | null = null;

  constructor(readonly tagName: string) {
    super(1, null);
  }

  override cloneNode(): FakeElement {
    const clone = new FakeElement(this.tagName);
    for (const [name, value] of this.attributes) clone.attributes.set(name, value);
    for (const value of this.classList.values) clone.classList.add(value);
    clone.rect = this.rect;
    clone.clientHeight = this.clientHeight;
    clone.style.height = this.style.height;
    return clone;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getBoundingClientRect(): RectShape {
    return this.rect;
  }

  compareDocumentPosition(node: FakeNode): number {
    return node === this.followingTarget ? 4 : 0;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches = (element: FakeElement): boolean => {
      if (selector === ".rr-mode-switch-anchor") {
        return element.classList.contains("rr-mode-switch-anchor");
      }
      return selector === "img,svg,canvas,video" &&
        ["img", "svg", "canvas", "video"].includes(element.tagName);
    };
    const result: FakeElement[] = [];
    const visit = (node: FakeNode): void => {
      if (node instanceof FakeElement && matches(node)) result.push(node);
      for (const child of node.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return result;
  }
}

class FakeRange {
  startContainer: FakeNode;
  startOffset = 0;
  endContainer: FakeNode;
  endOffset = 0;
  rect: RectShape = zeroRect();

  constructor(node: FakeNode) {
    this.startContainer = node;
    this.endContainer = node;
  }

  setStart(node: FakeNode, offset: number): void {
    if (offset < 0 || offset > (node.nodeValue ?? "").length) throw new Error("bad start");
    this.startContainer = node;
    this.startOffset = offset;
  }

  setEnd(node: FakeNode, offset: number): void {
    if (offset < 0 || offset > (node.nodeValue ?? "").length) throw new Error("bad end");
    this.endContainer = node;
    this.endOffset = offset;
  }

  getBoundingClientRect(): RectShape {
    return this.rect;
  }
}

class FakeDocument {
  nextRangeRect: RectShape = zeroRect();
  lastRange: FakeRange | null = null;

  createRange(): FakeRange {
    const range = new FakeRange(new FakeText(""));
    range.rect = this.nextRangeRect;
    this.lastRange = range;
    return range;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

function textRecord(node: FakeText, start: number): ReaderSourceTextRecord {
  return {
    node: node as unknown as Text,
    start,
    end: start + (node.nodeValue ?? "").length,
  };
}

function runtime(
  root: FakeElement,
  document: FakeDocument,
  records: () => readonly ReaderSourceTextRecord[],
): ReaderPageModeSwitchRuntime {
  return {
    root: root as unknown as HTMLElement,
    sourceTextCache: { stale: true },
    S: { marginTop: 12 },
    document: document as unknown as Document,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    sourceTextRecords: records,
    viewRect: () => ({ left: 0, right: 400, top: 0, bottom: 600 } as DOMRect),
    isScrollMode: () => false,
    mg: (value) => Number(value) || 0,
    viewportHeight: () => 700,
    lineHeightPx: () => 24,
    visibleTopTextAnchor: () => null,
    anchorTextOffset: () => null,
    anchorRect: () => null,
  };
}

test("installer exposes every original bare global and reads text records live", () => {
  const root = new FakeElement("div");
  const document = new FakeDocument();
  const first = new FakeText("abc");
  const second = new FakeText("defg");
  let records = [textRecord(first, 0), textRecord(second, 3)];
  const target = runtime(root, document, () => records);
  const api = installReaderPageModeSwitch(target);
  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(Object.keys(api), [
    "sourceAnchorRangeForOffset",
    "clearModeSwitchAnchor",
    "hasVisibleLeadMediaBeforeAnchor",
    "forceModeSwitchAnchorColumn",
    "padModeSwitchAnchorToColumnTop",
    "modeSwitchAnchorAtVisibleTop",
  ]);
  for (const key of Object.keys(api) as Array<keyof typeof api>) {
    assert.equal(target[key], api[key]);
  }

  const boundary = api.sourceAnchorRangeForOffset(3) as unknown as FakeRange;
  assert.equal(boundary.startContainer, second);
  assert.equal(boundary.startOffset, 0);
  assert.equal(boundary.endOffset, 1);
  const replacement = new FakeText("uvwxyz");
  records = [textRecord(replacement, 0)];
  const live = api.sourceAnchorRangeForOffset("4") as unknown as FakeRange;
  assert.equal(live.startContainer, replacement);
  assert.equal(live.startOffset, 4);
});

test("visible leading media requires both document order and two-axis viewport overlap", () => {
  const root = new FakeElement("div");
  const paragraph = new FakeElement("p");
  const text = new FakeText("title");
  const image = new FakeElement("img");
  root.appendChild(image);
  root.appendChild(paragraph);
  paragraph.appendChild(text);
  image.followingTarget = text;
  image.rect = { left: 20, right: 220, top: 20, bottom: 180, width: 200, height: 160 };
  const document = new FakeDocument();
  document.nextRangeRect = { left: 20, right: 120, top: 190, bottom: 220, width: 100, height: 30 };
  const target = runtime(root, document, () => [textRecord(text, 0)]);
  const api = installReaderPageModeSwitch(target);
  assert.equal(api.hasVisibleLeadMediaBeforeAnchor(0), true);
  image.rect = { left: 500, right: 700, top: 20, bottom: 180, width: 200, height: 160 };
  assert.equal(api.hasVisibleLeadMediaBeforeAnchor(0), false);
  image.rect = { left: 20, right: 220, top: 20, bottom: 180, width: 200, height: 160 };
  image.followingTarget = null;
  assert.equal(api.hasVisibleLeadMediaBeforeAnchor(0), false);
});

test("forced anchor splits to a root child and clear restores the exact text hierarchy", () => {
  const root = new FakeElement("div");
  const section = new FakeElement("section");
  const paragraph = new FakeElement("p");
  paragraph.setAttribute("id", "chapter-paragraph");
  const text = new FakeText("abcdefgh");
  root.appendChild(section);
  section.appendChild(paragraph);
  paragraph.appendChild(text);
  const document = new FakeDocument();
  const target = runtime(root, document, () => [textRecord(text, 0)]);
  const api = installReaderPageModeSwitch(target);

  assert.equal(api.forceModeSwitchAnchorColumn(4, true), false);
  const mark = api.forceModeSwitchAnchorColumn(4, false);
  assert.notEqual(mark, false);
  if (mark === false) return;
  assert.equal(mark.parentNode, root as unknown as ParentNode);
  assert.equal(mark.classList.contains("rr-mode-switch-anchor"), true);
  assert.equal(mark.classList.contains("rr-mode-switch-continuation"), true);
  assert.equal(mark.getAttribute("data-reader-offset"), "4");
  assert.equal(root.children.length, 2);
  assert.equal(target.sourceTextCache, null);

  target.sourceTextCache = { stale: true };
  api.clearModeSwitchAnchor();
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0], section);
  assert.equal(section.children.length, 1);
  assert.equal(section.children[0], paragraph);
  assert.equal(paragraph.children.length, 1);
  assert.equal(paragraph.children[0]?.nodeValue, "abcdefgh");
  assert.equal(target.sourceTextCache, null);
});

test("column spacer preserves the original threshold, height, ownership, and cleanup", () => {
  const root = new FakeElement("div");
  root.style.height = "600px";
  root.clientHeight = 600;
  root.rect = { left: 0, right: 400, top: 10, bottom: 610, width: 400, height: 600 };
  const mark = new FakeElement("section");
  mark.rect = { left: 0, right: 400, top: 210, bottom: 250, width: 400, height: 40 };
  mark.classList.add("rr-mode-switch-anchor");
  root.appendChild(mark);
  const document = new FakeDocument();
  const target = runtime(root, document, () => []);
  const api = installReaderPageModeSwitch(target);
  assert.equal(api.padModeSwitchAnchorToColumnTop(mark as unknown as HTMLElement), true);
  const spacer = root.children[0] as FakeElement;
  assert.equal(root.children[1], mark);
  assert.equal(spacer.attributes.get("data-reader-mode-switch-spacer"), "1");
  assert.match(spacer.style.cssText, /height:412px!important/u);
  assert.equal(mark.__rrModeSwitchSpacer, spacer);
  api.clearModeSwitchAnchor();
  assert.equal(root.children.includes(spacer), false);
});

test("visible-top verification keeps the exact line and offset tolerance", () => {
  const root = new FakeElement("div");
  const text = new FakeText("abcdefghijabcdefghij");
  const document = new FakeDocument();
  const target = runtime(root, document, () => [textRecord(text, 0)]);
  const visibleRange = new FakeRange(text);
  visibleRange.setStart(text, 6);
  visibleRange.setEnd(text, 7);
  target.visibleTopTextAnchor = () => ({ range: visibleRange as unknown as Range });
  target.anchorTextOffset = () => 6;
  target.anchorRect = (anchor) => {
    const range = anchor.range as unknown as FakeRange | undefined;
    return { ...zeroRect(), top: range === visibleRange ? 102 : 100 } as DOMRect;
  };
  const api = installReaderPageModeSwitch(target);
  assert.equal(api.modeSwitchAnchorAtVisibleTop(5), true);
  assert.equal(api.modeSwitchAnchorAtVisibleTop("5suffix"), false);
  target.anchorTextOffset = () => 18;
  assert.equal(api.modeSwitchAnchorAtVisibleTop(5), false);
  target.anchorTextOffset = () => 6;
  target.anchorRect = (anchor) => {
    const range = anchor.range as unknown as FakeRange | undefined;
    return { ...zeroRect(), top: range === visibleRange ? 120 : 100 } as DOMRect;
  };
  assert.equal(api.modeSwitchAnchorAtVisibleTop(5), false);
});
