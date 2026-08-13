import { useEffect, useRef, useState } from "react";
import { createImperativeReaderEngine } from "./imperative-reader-engine.js";
import { createReaderWindowController, type ReaderWindowState } from "./reader-window-controller.js";
import type { ReaderWindowPort } from "./reader-window-port.js";
import "./reader.css";

export interface ReaderPageProps {
  readonly port: ReaderWindowPort;
}

export function ReaderPage({ port }: ReaderPageProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ReturnType<typeof createReaderWindowController> | null>(null);
  const [state, setState] = useState<ReaderWindowState>({
    phase: "loading",
    book: null,
    notice: "正在打开图书…",
  });

  useEffect(() => {
    const controller = createReaderWindowController(port);
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(setState);
    let unlisten: (() => void) | null = null;
    let disposed = false;
    if (port.listenCloseRequested) {
      void port.listenCloseRequested(() => { void controller.close(); }).then((nextUnlisten) => {
        if (disposed) nextUnlisten();
        else unlisten = nextUnlisten;
      }).catch(() => {
        // The visible close button remains usable if the optional native event
        // bridge is unavailable during renderer startup.
      });
    }
    void controller.load();
    return () => {
      disposed = true;
      unlisten?.();
      unsubscribe();
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [port]);

  useEffect(() => {
    if (state.phase !== "ready" || !state.book || !host.current) return undefined;
    const engine = createImperativeReaderEngine();
    const unsubscribe = engine.onEvent(() => undefined);
    engine.mountBook(host.current, state.book);
    return () => {
      unsubscribe();
      engine.unmount();
    };
  }, [state.book, state.phase]);

  return (
    <main className="reader-page" aria-busy={state.phase === "loading"}>
      <header className="reader-page-chrome">
        <span className="reader-page-title">{state.book?.title ?? "阅读"}</span>
        <button
          className="reader-page-close"
          type="button"
          aria-label="关闭阅读窗口"
          onClick={() => { void controllerRef.current?.close(); }}
        >
          ×
        </button>
      </header>
      <div ref={host} className="reader-engine-host" />
      {state.phase !== "ready" && state.phase !== "closed" ? (
        <section className="reader-page-status" role={state.phase === "failed" ? "alert" : "status"}>
          <p>{state.notice ?? "正在准备阅读器…"}</p>
        </section>
      ) : null}
    </main>
  );
}
