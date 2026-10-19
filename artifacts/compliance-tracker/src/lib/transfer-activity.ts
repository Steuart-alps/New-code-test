/**
 * Counts requests in flight (fetch and XMLHttpRequest), so the idle sign-out
 * never fires in the middle of an upload or download. A large scan going
 * straight to file storage on a slow line can take longer than the idle limit
 * with no mouse or key activity and no call to our own server.
 */
let inFlight = 0;
let installed = false;

function track<T>(work: Promise<T>): Promise<T> {
  inFlight += 1;
  return work.finally(() => {
    inFlight -= 1;
  });
}

export function transfersInFlight(): number {
  return inFlight;
}

export function installTransferTracking(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = (...args: Parameters<typeof fetch>) => track(originalFetch(...args));

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function send(this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest["send"]>) {
    inFlight += 1;
    this.addEventListener("loadend", () => {
      inFlight -= 1;
    }, { once: true });
    try {
      return originalSend.apply(this, args);
    } catch (err) {
      inFlight -= 1;
      throw err;
    }
  };
}
