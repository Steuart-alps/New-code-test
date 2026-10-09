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
const approvalRefreshChannelPrefix = "complytrack:contractor-approval-refresh:";

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

function getLocalStorage(windowLike: ApprovalStorageWindow): Storage | null {
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
  if (!storageKey || !knownQueueIds) return;

  const state: PersistedApprovalRefreshState = {
    knownQueueIds: Array.from(knownQueueIds),
    newRequestIds,
  };
  const storage = getLocalStorage(windowLike);
  let persistedToStorage = false;
  if (storage) {
    try {
      storage.setItem(storageKey, JSON.stringify(state));
      persistedToStorage = true;
    } catch {
      // Privacy-restricted or quota-limited storage is handled by memory and
      // BroadcastChannel below.
    }
  }
  if (!persistedToStorage) {
    publishApprovalRefreshState(windowLike, storageKey, state);
  } else {
    approvalRefreshMemory.set(storageKey, state);
  }
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