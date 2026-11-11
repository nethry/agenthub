import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Fonts are bundled so the app works offline and under a strict CSP.
import "@fontsource/chakra-petch/400.css";
import "@fontsource/chakra-petch/500.css";
import "@fontsource/chakra-petch/600.css";
import "@fontsource/rajdhani/500.css";
import "@fontsource/rajdhani/600.css";
import "@fontsource/rajdhani/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "./styles/globals.css";
import { App } from "./app/App";
import { bootstrap } from "./app/actions";
import { initAppearance } from "./app/appearance";
import { toast } from "./app/store";
import { errorMessage } from "./lib/ipc";
import { monaco } from "./features/editor/monaco";

// Theme first, so the first frame already has the right colours.
initAppearance();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// xterm and Monaco measure glyphs once; make sure the mono font is ready first.
void Promise.all([
  document.fonts.load('12px "JetBrains Mono"'),
  document.fonts.load('500 12px "JetBrains Mono"'),
  document.fonts.load('13px "Chakra Petch"'),
  document.fonts.load('700 13px "Rajdhani"'),
  document.fonts.load('13px "Inter"'),
])
  .catch(() => {})
  .then(() => {
    monaco.editor.remeasureFonts();
    return bootstrap();
  })
  .catch((e) => toast(`AgentHub failed to start: ${errorMessage(e)}`, "danger"));

// Keep the webview from navigating away or opening dropped files.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());
