// ---- 单页/双页模式切换锚点 ----
//
// 这个 installer 必须把原有函数按原名安装到 classic global。
// layout/runtime/transition 仍通过裸全局符号调用它们；所有共享状态
// 也在每次调用时从该 global 读取，不保存会过期的快照。

export interface ReaderSourceTextRecord {
  readonly node: Text;
  readonly start: number;
  readonly end: number;
}

export interface ReaderTextAnchor {
  readonly range?: Range | null;
  readonly el?: Element | null;
}

export interface ReaderPageModeSettings {
  readonly marginTop?: unknown;
}

interface ModeSwitchPair {
  readonly origin: Node & ParentNode;
  readonly tail: Node & ParentNode;
}

export interface ModeSwitchElement extends Element {
  __rrModeSwitchPairs?: ModeSwitchPair[];
  __rrModeSwitchSpacer?: HTMLElement;
}

export type SourceAnchorRangeForOffset = (offset: unknown) => Range | null;
export type ClearModeSwitchAnchor = () => void;
export type HasVisibleLeadMediaBeforeAnchor = (offset: unknown) => boolean;
export type ForceModeSwitchAnchorColumn = (
  offset: unknown,
  preserveLeadMedia?: unknown,
) => ModeSwitchElement | false;
export type PadModeSwitchAnchorToColumnTop = (
  mark: ModeSwitchElement | null | false,
) => boolean;
export type ModeSwitchAnchorAtVisibleTop = (offset: unknown) => boolean;

export interface ReaderPageModeSwitchRuntime extends Record<string, unknown> {
  root?: HTMLElement | null;
  sourceTextCache?: unknown;
  S?: ReaderPageModeSettings | null;
  document: Document;
  Node: { readonly DOCUMENT_POSITION_FOLLOWING: number };
  sourceTextRecords: () => readonly ReaderSourceTextRecord[];
  viewRect: () => DOMRect;
  isScrollMode: () => boolean;
  mg: (value: unknown) => number;
  viewportHeight: () => number;
  lineHeightPx: () => number;
  visibleTopTextAnchor: () => ReaderTextAnchor | null;
  anchorTextOffset: (anchor: ReaderTextAnchor | null) => number | null;
  anchorRect: (anchor: ReaderTextAnchor) => DOMRect | null;
  sourceAnchorRangeForOffset?: SourceAnchorRangeForOffset;
  clearModeSwitchAnchor?: ClearModeSwitchAnchor;
  hasVisibleLeadMediaBeforeAnchor?: HasVisibleLeadMediaBeforeAnchor;
  forceModeSwitchAnchorColumn?: ForceModeSwitchAnchorColumn;
  padModeSwitchAnchorToColumnTop?: PadModeSwitchAnchorToColumnTop;
  modeSwitchAnchorAtVisibleTop?: ModeSwitchAnchorAtVisibleTop;
}

export interface ReaderPageModeSwitchApi {
  readonly sourceAnchorRangeForOffset: SourceAnchorRangeForOffset;
  readonly clearModeSwitchAnchor: ClearModeSwitchAnchor;
  readonly hasVisibleLeadMediaBeforeAnchor: HasVisibleLeadMediaBeforeAnchor;
  readonly forceModeSwitchAnchorColumn: ForceModeSwitchAnchorColumn;
  readonly padModeSwitchAnchorToColumnTop: PadModeSwitchAnchorToColumnTop;
  readonly modeSwitchAnchorAtVisibleTop: ModeSwitchAnchorAtVisibleTop;
}

function parsedOffset(value: unknown): number {
  // 类型断言只消除 TypeScript 的 parseInt 签名差异；运行时仍保留
  // 经典脚本 parseInt(offset, 10) 的 ECMAScript 强制转换语义。
  return Math.max(0, Number.parseInt(value as string, 10) || 0);
}

function modeElement(node: Node): ModeSwitchElement | null {
  return node.nodeType === 1 ? node as ModeSwitchElement : null;
}

function modeParent(node: Node): (Node & ParentNode) | null {
  return node.parentNode ? node.parentNode as Node & ParentNode : null;
}

function removeNode(node: Node): void {
  if (node.parentNode) node.parentNode.removeChild(node);
}

function restorePairs(pairs: readonly ModeSwitchPair[]): void {
  for (let index = pairs.length - 1; index >= 0; index -= 1) {
    const pair = pairs[index];
    if (!pair || !pair.tail.parentNode) continue;
    while (pair.tail.firstChild) pair.origin.appendChild(pair.tail.firstChild);
    removeNode(pair.tail);
  }
  const first = pairs[0];
  if (first?.origin) {
    try {
      first.origin.normalize();
    } catch {
      // 保持旧实现的容错：恢复结构后 normalize 失败不阻断重排。
    }
  }
}

export function installReaderPageModeSwitch(
  global: ReaderPageModeSwitchRuntime,
): ReaderPageModeSwitchApi {
  const sourceAnchorRangeForOffset: SourceAnchorRangeForOffset = (offset) => {
    const records = global.sourceTextRecords();
    const at = parsedOffset(offset);
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record) continue;
      const length = (record.node.nodeValue || "").length;
      if (at >= record.end && index < records.length - 1) continue;
      if (at > record.end) continue;
      const start = Math.max(0, Math.min(length, at - record.start));
      const end = Math.min(length, start + 1);
      if (end === start && index < records.length - 1) continue;
      const range = global.document.createRange();
      try {
        range.setStart(record.node, start);
        range.setEnd(record.node, end);
        return range;
      } catch {
        return null;
      }
    }
    return null;
  };

  const clearModeSwitchAnchor: ClearModeSwitchAnchor = () => {
    const root = global.root;
    if (!root) return;
    const marks = root.querySelectorAll<ModeSwitchElement>(".rr-mode-switch-anchor");
    for (const mark of marks) {
      const pairs = mark.__rrModeSwitchPairs;
      const spacer = mark.__rrModeSwitchSpacer;
      if (spacer?.parentNode) removeNode(spacer);
      if (pairs?.length) {
        // 目标字符可能位于 section/article/div/p/span 多层结构内。拆分时
        // 从内到外复制尾部；恢复时必须从外到内合并，才能把每一层放回
        // 原父节点，且不会永久改变 EPUB 的正文结构。
        restorePairs(pairs);
      } else {
        mark.classList.remove("rr-mode-switch-anchor");
        mark.removeAttribute("data-reader-mode-switch");
        mark.removeAttribute("data-reader-offset");
        mark.removeAttribute("data-reader-split");
      }
    }
    if (marks.length) global.sourceTextCache = null;
  };

  // 章节题图没有文字偏移。题图仍在当前页时不要强制标题另起一栏，否则会产生图标空页。
  const hasVisibleLeadMediaBeforeAnchor: HasVisibleLeadMediaBeforeAnchor = (offset) => {
    const root = global.root;
    if (!root || offset === null || offset === undefined) return false;
    const range = sourceAnchorRangeForOffset(offset);
    if (!range) return false;
    let anchorBox = range.getBoundingClientRect();
    if ((!anchorBox || (!anchorBox.width && !anchorBox.height)) && range.startContainer.parentElement) {
      anchorBox = range.startContainer.parentElement.getBoundingClientRect();
    }
    const viewport = global.viewRect();
    if (
      !anchorBox || anchorBox.bottom <= viewport.top + 2 || anchorBox.top >= viewport.bottom - 2 ||
      anchorBox.right <= viewport.left + 2 || anchorBox.left >= viewport.right - 2
    ) return false;
    const media = root.querySelectorAll<Element>("img,svg,canvas,video");
    for (const item of media) {
      if (!(item.compareDocumentPosition(range.startContainer) & global.Node.DOCUMENT_POSITION_FOLLOWING)) {
        continue;
      }
      const rect = item.getBoundingClientRect();
      if (
        rect.bottom > viewport.top + 2 && rect.top < viewport.bottom - 2 &&
        rect.right > viewport.left + 2 && rect.left < viewport.right - 2
      ) return true;
    }
    return false;
  };

  // CSS 多栏只可靠地接受多栏根的直接子节点作为强制断栏点。从目标字符
  // 开始逐层拆出尾部，直到得到 root 的直接子节点。
  const forceModeSwitchAnchorColumn: ForceModeSwitchAnchorColumn = (
    offset,
    preserveLeadMedia,
  ) => {
    const root = global.root;
    if (!root || offset === null || offset === undefined || preserveLeadMedia) return false;
    const range = sourceAnchorRangeForOffset(offset);
    if (!range) return false;
    let child: Node = range.startContainer;
    const pairs: ModeSwitchPair[] = [];
    if (child.nodeType !== 3 || !child.parentNode) return false;
    try {
      const textChild = child as Text;
      const textLength = (textChild.nodeValue || "").length;
      const start = Math.max(0, Math.min(textLength, range.startOffset));
      if (start > 0 || start === textLength) child = textChild.splitText(start);
      while (child.parentNode && child.parentNode !== root) {
        const origin = modeParent(child);
        const host = origin && modeParent(origin);
        if (!origin || !host) return false;
        const tail = origin.cloneNode(false) as Node & ParentNode;
        const tailElement = modeElement(tail);
        if (tailElement) {
          tailElement.removeAttribute("id");
          // 这是原段落在当前阅读位置之后的续接部分，不是新段落。
          tailElement.classList.add("rr-mode-switch-continuation");
        }
        let moving: Node | null = child;
        while (moving) {
          const next: Node | null = moving.nextSibling;
          tail.appendChild(moving);
          moving = next;
        }
        host.insertBefore(tail, origin.nextSibling);
        pairs.push({ origin, tail });
        child = tail;
      }
    } catch {
      // 若中途失败，立即按相反顺序恢复，不能把半拆分 DOM 留给分页器。
      restorePairs(pairs);
      global.sourceTextCache = null;
      return false;
    }
    const mark = modeElement(child);
    if (!mark || mark.parentNode !== root || !pairs.length) {
      // 没有成功拆到多栏根时同样必须回滚。
      restorePairs(pairs);
      global.sourceTextCache = null;
      return false;
    }
    mark.__rrModeSwitchPairs = pairs;
    mark.setAttribute("data-reader-split", "root-path");
    mark.classList.add("rr-mode-switch-anchor");
    mark.setAttribute("data-reader-mode-switch", "anchor");
    mark.setAttribute("data-reader-offset", String(offset));
    global.sourceTextCache = null;
    return mark;
  };

  // Chromium 对动态拆出的段落不总是执行 break-before:column。若目标文字
  // 仍在当前栏中部，则用无正文临时块补齐该栏剩余高度。
  const padModeSwitchAnchorToColumnTop: PadModeSwitchAnchorToColumnTop = (mark) => {
    const root = global.root;
    if (!mark || !root || global.isScrollMode() || !mark.parentNode) return false;
    const rootBox = root.getBoundingClientRect();
    const box = mark.getBoundingClientRect();
    const columnHeight = Math.max(
      1,
      Math.round(Number.parseFloat(root.style.height) || root.clientHeight || global.viewportHeight()),
    );
    const targetTop = Math.max(0, global.mg(global.S?.marginTop));
    const within = ((box.top - rootBox.top - targetTop) % columnHeight + columnHeight) % columnHeight;
    if (within <= Math.max(4, global.lineHeightPx() * 0.22)) return false;
    const spacer = global.document.createElement("div");
    spacer.setAttribute("aria-hidden", "true");
    spacer.setAttribute("data-reader-generated", "mode-switch-spacer");
    spacer.setAttribute("data-reader-mode-switch-spacer", "1");
    spacer.style.cssText = `display:block!important;width:1px!important;height:${
      Math.max(1, Math.ceil(columnHeight - within))
    }px!important;margin:0!important;padding:0!important;border:0!important;line-height:0!important;font-size:0!important;`;
    mark.parentNode.insertBefore(spacer, mark);
    mark.__rrModeSwitchSpacer = spacer;
    return true;
  };

  const modeSwitchAnchorAtVisibleTop: ModeSwitchAnchorAtVisibleTop = (offset) => {
    if (offset === null || offset === undefined) return false;
    const visible = global.visibleTopTextAnchor();
    const actual = global.anchorTextOffset(visible);
    if (actual === null) return false;
    const target = sourceAnchorRangeForOffset(offset);
    const sample = visible?.range;
    const targetRect = target ? global.anchorRect({ range: target }) : null;
    const sampleRect = sample ? global.anchorRect({ range: sample }) : null;
    if (!targetRect || !sampleRect) return false;
    const sameLine = Math.abs(targetRect.top - sampleRect.top) <= Math.max(
      3,
      global.lineHeightPx() * 0.25,
    );
    // 这里保留旧代码比较时的 Number 强制转换；它与上面定位 Range
    // 所用的 parseInt 是两个独立历史边界，不应在迁移时悄然合并。
    const expected = Number(offset);
    return sameLine && actual >= expected - 1 && actual <= expected + 12;
  };

  Object.assign(global, {
    sourceAnchorRangeForOffset,
    clearModeSwitchAnchor,
    hasVisibleLeadMediaBeforeAnchor,
    forceModeSwitchAnchorColumn,
    padModeSwitchAnchorToColumnTop,
    modeSwitchAnchorAtVisibleTop,
  });

  return Object.freeze({
    sourceAnchorRangeForOffset,
    clearModeSwitchAnchor,
    hasVisibleLeadMediaBeforeAnchor,
    forceModeSwitchAnchorColumn,
    padModeSwitchAnchorToColumnTop,
    modeSwitchAnchorAtVisibleTop,
  });
}
