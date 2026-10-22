import { createRoot } from "react-dom/client";
import React from "react";
import App from "./App";
import "./index.css";
import { errorReportsEnabled, initErrorReports, reportError } from "./lib/error-reports";
import {
  installNewReleaseReload,
  isChunkLoadError,
  isReloadingForNewRelease,
  reloadForNewRelease,
} from "./lib/new-release-reload";

// Initialise Sentry before the React tree mounts so all component errors and
// navigation events are captured from the first render. SENTRY_DSN is read at
// build time (vite.config.ts); without it nothing is sent.
initErrorReports();

// A tab left open across a release reloads itself when it asks for a page file
// the release removed, instead of showing the error page.
installNewReleaseReload();

// ── Global React error boundary ────────────────────────────────────────────
// Catches unhandled rendering errors anywhere in the tree and shows a friendly
// fallback instead of a blank white screen.

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
  // A page file from before the latest release could not load and the page is
  // reloading to fetch the new one.
  reloading: boolean;
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: "", reloading: false };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const message =
      error instanceof Error ? error.message : "An unexpected error occurred.";
    const reloading = isReloadingForNewRelease() || isChunkLoadError(error);
    return { hasError: true, message, reloading };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    if (this.state.reloading) {
      if (reloadForNewRelease()) return;
      this.setState({ reloading: false });
    }
    reportError(error, { componentStack: info.componentStack });
    console.error("[ErrorBoundary]", error, info);
  }

  render() {
    if (this.state.hasError && this.state.reloading) {
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#f8fafc",
            fontFamily: "system-ui, sans-serif",
            fontSize: 14,
            color: "#64748b",
            padding: "24px",
          }}
        >
          Loading the latest version of ComplyTrack…
        </div>
      );
    }
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
              An unexpected error occurred.{" "}
              {errorReportsEnabled() ? "Our team has been notified. " : ""}
              Please try reloading the page — if the problem persists, contact support.
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
