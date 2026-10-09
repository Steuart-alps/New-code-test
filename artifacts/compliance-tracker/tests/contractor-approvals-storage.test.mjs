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

class BroadcastHub {
  channels = new Set();

  connect(name) {
    const listeners = new Set();
    const endpoint = {
      addEventListener: (type, listener) => {
        if (type === "message") listeners.add(listener);
      },
      close: () => {
        this.channels.delete(endpoint);
        listeners.clear();
      },
      postMessage: data => {
        for (const other of this.channels) {
          if (other !== endpoint && other.name === name) {
            for (const listener of other.listeners) {
              listener({ data });
            }
          }
        }
      },
      name,
      listeners,
    };
    this.channels.add(endpoint);
    return endpoint;
  }
}

class FakeBrowserContext {
  constructor(storage, broadcastHub = new BroadcastHub()) {
    this.localStorage = storage;
    this.listeners = new Set();
    this.broadcastHub = broadcastHub;
    storage.contexts.add(this);
  }

  get BroadcastChannel() {
    const hub = this.broadcastHub;
    return class FakeBroadcastChannel {
      constructor(name) {
        this.endpoint = hub.connect(name);
      }

      addEventListener(type, listener) {
        this.endpoint.addEventListener(type, listener);
      }

      postMessage(data) {
        this.endpoint.postMessage(data);
      }

      close() {
        this.endpoint.close();
      }
    };
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

class BlockedStorage {
  contexts = new Set();

  getItem() {
    throw new Error("storage access denied");
  }

  setItem() {
    throw new Error("storage access denied");
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
    readPersistedApprovalRefreshState,
    persistApprovalRefreshState,
    subscribeToApprovalRefreshStorage,
  } = await import(`${pathToFileURL(helperBundle).href}?t=${Date.now()}`);

  const storage = new SharedLocalStorage();
  const broadcastHub = new BroadcastHub();
  const firstTab = new FakeBrowserContext(storage, broadcastHub);
  const secondTab = new FakeBrowserContext(storage, broadcastHub);
  const otherClientTab = new FakeBrowserContext(storage, broadcastHub);
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
    persistApprovalRefreshState(firstTab, sharedKey, new Set([101, 202]), [202]);
  });

  assert.deepEqual(secondTabState, {
    knownQueueIds: [101, 202],
    newRequestIds: [202],
  });
  assert.deepEqual(queueRows, [{ id: 101, draft: "Keep this draft" }]);
  assert.equal(otherClientEvents, 0, "a different client must not receive the shared update");

  storage.asWrittenBy(firstTab, () => {
    persistApprovalRefreshState(firstTab, sharedKey, new Set([101, 202]), []);
  });
  assert.deepEqual(secondTabState.newRequestIds, [], "acknowledgment must clear the other tab");
  assert.deepEqual(queueRows, [{ id: 101, draft: "Keep this draft" }]);

  unsubscribeSecondTab();
  storage.asWrittenBy(firstTab, () => {
    persistApprovalRefreshState(firstTab, sharedKey, new Set([101, 202]), [202]);
  });
  assert.deepEqual(
    secondTabState.newRequestIds,
    [],
    "unsubscribed tabs must stop receiving shared updates",
  );

  // Privacy-restricted storage still preserves the same tab's baseline and
  // synchronizes only the matching user/client key through BroadcastChannel.
  const blockedHub = new BroadcastHub();
  const blockedStorage = new BlockedStorage();
  const blockedFirstTab = new FakeBrowserContext(blockedStorage, blockedHub);
  const blockedSecondTab = new FakeBrowserContext(blockedStorage, blockedHub);
  const blockedOtherClientTab = new FakeBrowserContext(blockedStorage, blockedHub);
  const blockedOtherClientKey = getApprovalRefreshStorageKey(7, 43);
  let blockedSecondTabState = null;
  let blockedOtherClientEvents = 0;
  const unsubscribeBlockedSecondTab = subscribeToApprovalRefreshStorage(
    blockedSecondTab,
    sharedKey,
    state => {
      blockedSecondTabState = state;
    },
  );
  subscribeToApprovalRefreshStorage(blockedOtherClientTab, blockedOtherClientKey, () => {
    blockedOtherClientEvents += 1;
  });
  persistApprovalRefreshState(
    blockedFirstTab,
    sharedKey,
    new Set([303]),
    [303],
  );
  assert.deepEqual(blockedSecondTabState, {
    knownQueueIds: [303],
    newRequestIds: [303],
  });
  assert.equal(blockedOtherClientEvents, 0, "blocked storage must not cross client scopes");
  assert.deepEqual(
    readPersistedApprovalRefreshState(blockedFirstTab, sharedKey),
    { knownQueueIds: [303], newRequestIds: [303] },
    "same-tab navigation can use the scoped memory fallback",
  );
  unsubscribeBlockedSecondTab();

  console.log("Contractor approval cross-tab storage safeguards passed.");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}