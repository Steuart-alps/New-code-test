// Import the app only after Sentry has installed its Node/HTTP instrumentation.
// Static imports in index.ts would be evaluated before an initSentry() call there.
import { initSentry } from "./lib/sentry";

initSentry();
await import("./index");