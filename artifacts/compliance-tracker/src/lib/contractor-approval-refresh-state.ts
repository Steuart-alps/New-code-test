export interface PersistedApprovalRefreshState {
  knownQueueIds: number[];
  newRequestIds: number[];
}

type ApprovalRefreshMessage = {
  storageKey: string;
  state: PersistedApprovalRefreshState;
};

export type ApprovalStorageWindow = Pick<
  Window,
  "localStorage" | "addEventListener" | "removeEventListener"
> & {
  BroadcastChannel?: typeof BroadcastChannel;
};

const approvalRefreshMemory = new Map<string, PersistedApprovalRefreshState>();
// Keys cleared at sign-out. A queue load that was already in flight must not
// write them back; the next read for the key (a fresh page load after signing
// in again) lifts the block.
const signedOutKeys = new Set<string>();
const approvalRefreshChannelPrefix = "complytrack:contractor-approval-refresh:";
const approvalRefreshKeyPrefix = "complytrack:contractor-approvals:";

function getApprovalRefreshChannelName(storageKey: string) {
  return `${approvalRefreshChannelPrefix}${storageKey}`;
}

export function getApprovalRefreshStorageKey(
  userId: number | null,
  clientId: number | null,
) {
  return userId !== null && clientId !== null
    ? `complytrack:contractor-approvals:${userId}:${clientId}`
    : null;
}

/** Forgets one user's acknowledgment state for every client in this browser,
 *  so their next sign-in starts from a fresh baseline. Keys belonging to other
 *  users are never read or removed (the trailing ":" keeps user 1 from
 *  matching user 12). */
export function clearApprovalRefreshStateForUser(
  windowLike: Pick<ApprovalStorageWindow, "localStorage">,
  userId: number | null,
) {
  if (userId === null) return;
  const userPrefix = `${approvalRefreshKeyPrefix}${userId}:`;

  const keys = new Set(
    Array.from(approvalRefreshMemory.keys()).filter(key => key.startsWith(userPrefix)),
  );
  const storage = getLocalStorage(windowLike);
  if (storage) {
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(userPrefix)) keys.add(key);
      }
    } catch {
      // Unreadable storage holds nothing of ours to remove.
    }
  }

  for (const key of keys) {
    approvalRefreshMemory.delete(key);
    signedOutKeys.add(key);
    try {
      storage?.removeItem(key);
    } catch {
      // Blocked storage: the in-memory copy above is already gone.
    }
  }
}

export function parsePersistedApprovalRefreshState(raw: string | null) {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedApprovalRefreshState>;
    if (
      !Array.isArray(parsed.knownQueueIds) ||
      !Array.isArray(parsed.newRequestIds) ||
      !parsed.knownQueueIds.every(Number.isInteger) ||
      !parsed.newRequestIds.every(Number.isInteger)
    ) {
      return null;
    }
    return {
      knownQueueIds: parsed.knownQueueIds,
      newRequestIds: parsed.newRequestIds,
    };
  } catch {
    return null;
  }
}

function getLocalStorage(windowLike: Pick<ApprovalStorageWindow, "localStorage">): Storage | null {
  try {
    return windowLike.localStorage;
  } catch {
    return null;
  }
}

function publishApprovalRefreshState(
  windowLike: ApprovalStorageWindow,
  storageKey: string,
  state: PersistedApprovalRefreshState,
) {
  approvalRefreshMemory.set(storageKey, state);
  const BroadcastChannelConstructor = windowLike.BroadcastChannel;
  if (!BroadcastChannelConstructor) return;

  try {
    const channel = new BroadcastChannelConstructor(getApprovalRefreshChannelName(storageKey));
    channel.postMessage({ storageKey, state } satisfies ApprovalRefreshMessage);
    channel.close();
  } catch {
    // BroadcastChannel is optional; the local tab still has its memory state.
  }
}

export function readPersistedApprovalRefreshState(
  windowLike: ApprovalStorageWindow,
  storageKey: string | null,
) {
  if (!storageKey) return null;
  signedOutKeys.delete(storageKey);

  const storage = getLocalStorage(windowLike);
  if (storage) {
    try {
      const persisted = parsePersistedApprovalRefreshState(storage.getItem(storageKey));
      if (persisted) {
        approvalRefreshMemory.set(storageKey, persisted);
        return persisted;
      }
    } catch {
      // Fall through to the scoped in-memory snapshot.
    }
  }
  return approvalRefreshMemory.get(storageKey) ?? null;
}

export function persistApprovalRefreshState(
  windowLike: ApprovalStorageWindow,
  storageKey: string | null,
  knownQueueIds: Set<number> | null,
  newRequestIds: number[],
) {
  if (!storageKey || !knownQueueIds || signedOutKeys.has(storageKey)) return;

  const state: PersistedApprovalRefreshState = {
    knownQueueIds: Array.from(knownQueueIds),
    newRequestIds,
  };
  const storage = getLocalStorage(windowLike);
  if (storage) {
    try {
      storage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // Privacy-restricted or quota-limited storage is handled by memory and
      // BroadcastChannel below.
    }
  }
  // Always broadcast as well: WebKit does not reliably deliver cross-tab
  // "storage" events (notably in private/ephemeral sessions), and
  // privacy-restricted storage never fires them. Subscribers treat a repeated
  // state as idempotent, so receiving it both ways is harmless.
  publishApprovalRefreshState(windowLike, storageKey, state);
}

export function subscribeToApprovalRefreshStorage(
  windowLike: ApprovalStorageWindow,
  storageKey: string | null,
  onState: (state: PersistedApprovalRefreshState) => void,
) {
  if (!storageKey) return () => {};
  const scopedStorageKey = storageKey;

  const storage = getLocalStorage(windowLike);
  function handleStorage(event: StorageEvent) {
    if (event.storageArea !== storage || event.key !== scopedStorageKey) return;
    const state = parsePersistedApprovalRefreshState(event.newValue);
    if (state) {
      approvalRefreshMemory.set(scopedStorageKey, state);
      onState(state);
    }
  }

  if (storage) windowLike.addEventListener("storage", handleStorage);

  let channel: BroadcastChannel | null = null;
  const BroadcastChannelConstructor = windowLike.BroadcastChannel;
  if (BroadcastChannelConstructor) {
    try {
      channel = new BroadcastChannelConstructor(getApprovalRefreshChannelName(scopedStorageKey));
      channel.addEventListener("message", (event: MessageEvent<ApprovalRefreshMessage>) => {
        if (event.data?.storageKey !== scopedStorageKey) return;
        const state = event.data.state;
        if (
          state &&
          Array.isArray(state.knownQueueIds) &&
          Array.isArray(state.newRequestIds) &&
          state.knownQueueIds.every(Number.isInteger) &&
          state.newRequestIds.every(Number.isInteger)
        ) {
          approvalRefreshMemory.set(scopedStorageKey, state);
          onState(state);
        }
      });
    } catch {
      channel = null;
    }
  }

  return () => {
    if (storage) windowLike.removeEventListener("storage", handleStorage);
    channel?.close();
  };
}