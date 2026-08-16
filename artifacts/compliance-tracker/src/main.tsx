import * as Sentry from "@sentry/react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Initialise Sentry before the React tree mounts so all component errors and
// navigation events are captured from the first render.
// VITE_SENTRY_DSN is forwarded from the server-side SENTRY_DSN secret via
// vite.config.ts define — no separate secret needed.
if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN as string,
    environment: import.meta.env.MODE,
    integrations: [Sentry.browserTracingIntegration()],
    // Capture 10 % of page-load / navigation transactions for performance.
    tracesSampleRate: 0.1,
  });
}

createRoot(document.getElementById("root")!).render(<App />);
