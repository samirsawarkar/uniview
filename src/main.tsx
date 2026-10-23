import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import "./ui/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Tell the desktop shell the UI can receive files (it queues argv/file-association opens until then).
(window as unknown as { uniview?: { ready?: () => void } }).uniview?.ready?.();
