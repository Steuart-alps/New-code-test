import * as Sentry from "@sentry/react";
import { createRoot } from "react-dom/client";
import React from "react";
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
    sendDefaultPii: false,
    integrations: [Sentry.browserTracingIntegration()],
    beforeSend(event) {
      // Links and API calls may include short-lived bearer tokens in their
      // path or query string. Do not send them to an external error service.
      const redactUrl = (value: string) => {
        try {
          const url = new URL(value, window.location.origin);
          return `${url.origin}${url.pathname}`.replace(
            /(\/(?:sign-off|contractor-portal|fix-track\/action|fix-track\/quotes\/public)\/)[^/]+/g,
            "$1[redacted]",
          );
        } catch {
          return "[redacted]";
        }
      };
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.headers;
        delete event.request.query_string;
        if (event.request.url) event.request.url = redactUrl(event.request.url);
      }
      event.breadcrumbs?.forEach(breadcrumb => {
        if (typeof breadcrumb.data?.url === "string") {
          breadcrumb.data.url = redactUrl(breadcrumb.data.url);
        }
      });
      return event;
    },
    // Capture 10 % of page-load / navigation transactions for performance.
    tracesSampleRate: 0.1,
  });
}

// ── Global React error boundary ────────────────────────────────────────────
// Catches unhandled rendering errors anywhere in the tree and shows a friendly
// fallback instead of a blank white screen.

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const message =
      error instanceof Error ? error.message : "An unexpected error occurred.";
    return { hasError: true, message };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    // Forward to Sentry if it's been initialised
    if (import.meta.env.VITE_SENTRY_DSN) {
      Sentry.captureException(error, { extra: { componentStack: info.componentStack } });
    }
    console.error("[ErrorBoundary]", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#f8fafc",
            fontFamily: "system-ui, sans-serif",
            padding: "24px",
          }}
        >
          <div
            style={{
              maxWidth: 480,
              width: "100%",
              background: "#fff",
              borderRadius: 16,
              border: "1px solid #e2e8f0",
              boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
              padding: "40px 32px",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
            <h1
              style={{ fontSize: 20, fontWeight: 700, color: "#0f172a", marginBottom: 8 }}
            >
              Something went wrong
            </h1>
            <p style={{ fontSize: 14, color: "#64748b", marginBottom: 24 }}>
              An unexpected error occurred. Our team has been notified. Please
              try reloading the page — if the problem persists, contact support.
            </p>
            {this.state.message && (
              <p
                style={{
                  fontSize: 12,
                  color: "#94a3b8",
                  background: "#f1f5f9",
                  borderRadius: 8,
                  padding: "10px 14px",
                  marginBottom: 24,
                  wordBreak: "break-word",
                  textAlign: "left",
                }}
              >
                {this.state.message}
              </p>
            )}
            <button
              onClick={() => window.location.reload()}
              style={{
                background: "#0f172a",
                color: "#fff",
                border: "none",
                borderRadius: 10,
                padding: "12px 28px",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Reload page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
