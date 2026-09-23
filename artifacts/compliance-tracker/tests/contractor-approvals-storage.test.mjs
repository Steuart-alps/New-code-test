import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = await mkdtemp(path.join(tmpdir(), "contractor-approvals-storage-"));
const helperBundle = path.join(tempDir, "contractor-approval-refresh-state.mjs");

class SharedLocalStorage {
  values = new Map();
  contexts = new Set();
  writer = null;

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    const oldValue = this.getItem(key);
    this.values.set(key, String(value));
    for (const context of this.contexts) {
      if (context !== this.writer) {
        context.dispatchStorage({
          key,
          oldValue,
          newValue: String(value),
          storageArea: this,
        });
      }
    }
  }

  asWrittenBy(context, callback) {
    this.writer = context;
    try {
      return callback();
    } finally {
      this.writer = null;
    }
  }
}

class FakeBrowserContext {
  constructor(storage) {
    this.localStorage = storage;
    this.listeners = new Set();
    storage.contexts.add(this);
  }

  addEventListener(type, listener) {
    if (type === "storage") this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === "storage") this.listeners.delete(listener);
  }

  dispatchStorage(event) {
    for (const listener of this.listeners) listener(event);
  }
}

try {
  await build({
    entryPoints: [path.join(root, "src/lib/contractor-approval-refresh-state.ts")],
    outfile: helperBundle,
    bundle: true,
    format: "esm",
    platform: "node",
  });

  const {
    getApprovalRefreshStorageKey,
    persistApprovalRefreshState,
    subscribeToApprovalRefreshStorage,
  } = await import(`${pathToFileURL(helperBundle).href}?t=${Date.now()}`);

  const storage = new SharedLocalStorage();
  const firstTab = new FakeBrowserContext(storage);
  const secondTab = new FakeBrowserContext(storage);
  const otherClientTab = new FakeBrowserContext(storage);
  const sharedKey = getApprovalRefreshStorageKey(7, 42);
  const otherClientKey = getApprovalRefreshStorageKey(7, 43);
  const queueRows = [{ id: 101, draft: "Keep this draft" }];
  let secondTabState = {
    knownQueueIds: [101],
    newRequestIds: [101],
  };
  let otherClientEvents = 0;

  storage.values.set(
    sharedKey,
    JSON.stringify({ knownQueueIds: [101], newRequestIds: [101] }),
  );
  const unsubscribeSecondTab = subscribeToApprovalRefreshStorage(
    secondTab,
    sharedKey,
    state => {
      secondTabState = state;
    },
  );
  subscribeToApprovalRefreshStorage(otherClientTab, otherClientKey, () => {
    otherClientEvents += 1;
  });

  storage.asWrittenBy(firstTab, () => {
    persistApprovalRefreshState(storage, sharedKey, new Set([101, 202]), [202]);
  });

  assert.deepEqual(secondTabState, {
    knownQueueIds: [101, 202],
    newRequestIds: [202],
  });
  assert.deepEqual(queueRows, [{ id: 101, draft: "Keep this draft" }]);
  assert.equal(otherClientEvents, 0, "a different client must not receive the shared update");

  storage.asWrittenBy(firstTab, () => {
    persistApprovalRefreshState(storage, sharedKey, new Set([101, 202]), []);
  });
  assert.deepEqual(secondTabState.newRequestIds, [], "acknowledgment must clear the other tab");
  assert.deepEqual(queueRows, [{ id: 101, draft: "Keep this draft" }]);

  unsubscribeSecondTab();
  storage.asWrittenBy(firstTab, () => {
    persistApprovalRefreshState(storage, sharedKey, new Set([101, 202]), [202]);
  });
  assert.deepEqual(
    secondTabState.newRequestIds,
    [],
    "unsubscribed tabs must stop receiving shared updates",
  );

  console.log("Contractor approval cross-tab storage safeguards passed.");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}