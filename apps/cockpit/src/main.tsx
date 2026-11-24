import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { FAVICON_SVG } from "./components/Icons";
import "./styles.css";

if (!document.querySelector("link[rel='icon']")) {
  const icon = document.createElement("link");
  icon.rel = "icon";
  icon.type = "image/svg+xml";
  icon.href = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`;
  document.head.appendChild(icon);
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
