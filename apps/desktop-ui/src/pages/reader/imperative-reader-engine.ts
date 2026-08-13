import type { ReaderEnginePort, ReaderFrameEvent, ReaderShellCommand, ReaderUnsubscribe } from "../../../../../packages/reader-engine/src/index.js";
import type { ReaderBookInfo } from "./reader-window-port.js";

export interface ImperativeReaderEngine extends ReaderEnginePort {
  mountBook(host: HTMLElement, book: ReaderBookInfo): void;
}

function iframeSource(book: ReaderBookInfo): string {
  if (book.format !== "pdf") {
    const source = new URL(book.resourceUrl);
    source.searchParams.set("rc", String(book.resumeChapter));
    source.searchParams.set("rf", String(book.resumeFraction));
    return source.href;
  }
  const source = new URL("pdfview.html", window.location.href);
  source.searchParams.set("u", book.resourceUrl);
  source.searchParams.set("p", String(book.resumeChapter + 1));
  return source.href;
}

/**
 * Thin DOM host for the existing reader engine. No page, selection, gesture,
 * EPUB layout or PDF canvas code is reimplemented here.
 */
export function createImperativeReaderEngine(): ImperativeReaderEngine {
  let frame: HTMLIFrameElement | null = null;
  let mounted = false;
  const eventListeners = new Set<(event: ReaderFrameEvent) => void>();

  const unmount = (): void => {
    if (!frame) return;
    frame.remove();
    frame = null;
    mounted = false;
  };

  return {
    mount(host: HTMLElement): void {
      if (mounted) throw new Error("Reader engine is already mounted.");
      const next = document.createElement("iframe");
      next.title = "阅读正文";
      next.setAttribute("data-reader-engine", "imperative");
      next.setAttribute("sandbox", "allow-scripts allow-same-origin");
      host.replaceChildren(next);
      frame = next;
      mounted = true;
    },
    mountBook(host: HTMLElement, book: ReaderBookInfo): void {
      this.mount(host);
      const next = frame;
      if (!next) return;
      next.addEventListener("load", () => {
        const engine = book.format === "pdf" ? "pdf" : "epub";
        for (const listener of eventListeners) {
          listener({ protocol: "kunpeng-reader-engine", version: 1, action: "ready", payload: { engine } });
        }
      }, { once: true });
      next.src = iframeSource(book);
    },
    unmount,
    send(command: ReaderShellCommand): void {
      if (!frame?.contentWindow) return;
      // The command protocol already validates the bounded payload.  The
      // existing engine owns its own command interpretation and DOM work.
      frame.contentWindow.postMessage(command, window.location.origin);
    },
    onEvent(listener: (event: ReaderFrameEvent) => void): ReaderUnsubscribe {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  };
}
