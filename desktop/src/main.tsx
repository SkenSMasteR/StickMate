import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

async function start() {
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    const { installBackend } = await import("./test/backend");
    installBackend("main");
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void start();
