import { createRoot } from "react-dom/client";
import { transportFromTauriGlobal } from "../../../packages/tauri-api/src/index.js";
import { ReaderPage } from "../pages/reader/ReaderPage.js";
import { createTauriReaderWindowPort } from "../pages/reader/reader-window-port.js";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Reader root is unavailable.");

const port = createTauriReaderWindowPort(transportFromTauriGlobal());
createRoot(rootElement).render(<ReaderPage port={port} />);
