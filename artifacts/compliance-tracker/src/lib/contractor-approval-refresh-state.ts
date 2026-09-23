export interface PersistedApprovalRefreshState {
  knownQueueIds: number[];
  newRequestIds: number[];
}

type ApprovalStorageWindow = Pick<
  Window,
  "localStorage" | "addEventListener" | "removeEventListener"
>;

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

export function readPersistedApprovalRefreshState(
  storage: Storage,
  storageKey: string | null,
) {
  if (!storageKey) return null;

  try {
    return parsePersistedApprovalRefreshState(storage.getItem(storageKey));
  } catch {
    return null;
  }
}

export function persistApprovalRefreshState(
  storage: Storage,
  storageKey: string | null,
  knownQueueIds: Set<number> | null,
  newRequestIds: number[],
) {
  if (!storageKey || !knownQueueIds) return;

  try {
    const state: PersistedApprovalRefreshState = {
      knownQueueIds: Array.from(knownQueueIds),
      newRequestIds,
    };
    storage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // Local storage may be unavailable or quota-limited; in-memory state still works.
  }
}

export function subscribeToApprovalRefreshStorage(
  windowLike: ApprovalStorageWindow,
  storageKey: string | null,
  onState: (state: PersistedApprovalRefreshState) => void,
) {
  if (!storageKey) return () => {};

  function handleStorage(event: StorageEvent) {
    if (event.storageArea !== windowLike.localStorage || event.key !== storageKey) {
      return;
    }
    const state = parsePersistedApprovalRefreshState(event.newValue);
    if (state) onState(state);
  }

  windowLike.addEventListener("storage", handleStorage);
  return () => windowLike.removeEventListener("storage", handleStorage);
}