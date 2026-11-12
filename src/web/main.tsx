import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { App } from "./App.tsx";
import { parseRoute } from "./lib/route.ts";
import { prime, takeOver } from "./lib/store.ts";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");
// The same paths App asks for on this route.
const route = parseRoute(new URL(location.href));
const paths = ["/api/state", ...(route.work === null ? [] : [`/api/work/${encodeURIComponent(route.work)}`]), ...(route.tab === "media" || route.work !== null ? ["/api/media"] : [])];
// After a reload the tab still has what it was showing, and draws it before the browser paints anything.
// A new tab waits for the hub, and for the mono font, which is inlined in the CSS and decodes in
// milliseconds: drawing after it keeps the lines that hold code from rewrapping on load.
const tookOver = takeOver(paths);
if (!tookOver) await Promise.all([document.fonts.load('1em "JetBrains Mono Variable"').catch(() => undefined), prime(paths)]);
let drawn = false;
flushSync(() =>
  // What was taken over is gone from the tab by now, so if it can't be drawn, loading again starts from the hub.
  createRoot(root, { onUncaughtError: (error) => (tookOver && !drawn ? location.reload() : reportError(error)) }).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
drawn = true;
