export interface KitchenOwner { clientId: number; userId: number }
export type KitchenDeliveryState = 'queued' | 'sending' | 'sent' | 'failed' | 'restored';
/** 'sent' (confirmed by the server) and 'restored' (a rejected entry turned
 *  back into an editable draft; its original payload is kept unchanged) are
 *  terminal: neither is sent again or blocks a new entry for its diary. */
const isTerminal = (state: KitchenDeliveryState) => state === 'sent' || state === 'restored';
export interface KitchenEntry {
  entryId: string;
  owner: KitchenOwner;
  siteId: number | null;
  recordDate: string;
  recordId: number | null;
  body: Record<string, unknown>;
  state: KitchenDeliveryState;
  createdAt: string;
  error?: string;
}
export interface KitchenOutboxSnapshot {
  owner: KitchenOwner | null;
  entries: KitchenEntry[];
  error: string | null;
}
interface OutboxDependencies {
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
  };
  send(entry: KitchenEntry, token: string): Promise<void>;
  onSent(): Promise<void>;
}

export const kitchenOutboxKey = (owner: KitchenOwner) =>
  `complytrack:kitchen-outbox:v1:${owner.clientId}:${owner.userId}`;
const sameOwner = (a: KitchenOwner, b: KitchenOwner) =>
  a.clientId === b.clientId && a.userId === b.userId;

/** Credentials stay in memory. Disk writes finish before the first HTTP attempt. */
export class KitchenOutbox {
  private session: { owner: KitchenOwner; token: string; generation: number } | null = null;
  private generation = 0;
  private lock: Promise<unknown> = Promise.resolve();
  private replaying: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private snapshot: KitchenOutboxSnapshot = { owner: null, entries: [], error: null };
  constructor(private deps: OutboxDependencies) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(owner: KitchenOwner, entries: KitchenEntry[], error: string | null = null) {
    if (!this.session || !sameOwner(owner, this.session.owner)) return;
    this.snapshot = { owner, entries, error };
    this.listeners.forEach(listener => listener());
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const operation = this.lock.then(fn, fn);
    this.lock = operation.catch(() => {});
    return operation;
  }
  private async read(owner: KitchenOwner): Promise<KitchenEntry[]> {
    const raw = await this.deps.storage.getItem(kitchenOutboxKey(owner));
    if (!raw) return [];
    let value: unknown;
    try { value = JSON.parse(raw); } catch {
      throw new Error('Saved KitchenTrack entries could not be read. The device copy has not been removed.');
    }
    if (!Array.isArray(value) || value.some(entry =>
      !entry || typeof entry !== 'object'
      || !entry.owner || !sameOwner(entry.owner, owner)
      || !/^[A-Za-z0-9_-]{12,100}$/.test(entry.entryId)
      || !/^\d{4}-\d{2}-\d{2}$/.test(entry.recordDate)
      || !(entry.siteId === null || Number.isSafeInteger(entry.siteId) && entry.siteId > 0)
      || !(entry.recordId === null || Number.isSafeInteger(entry.recordId) && entry.recordId > 0)
      || !entry.body || typeof entry.body !== 'object' || Array.isArray(entry.body)
      || entry.body.mobileEntryId !== entry.entryId
      || (entry.recordId === null
        ? entry.body.recordDate !== entry.recordDate
        : entry.body.mobileRecordDate !== entry.recordDate || !entry.body.mobileTemperatureLog)
      || !['queued', 'sending', 'sent', 'failed', 'restored'].includes(entry.state)
      || typeof entry.createdAt !== 'string'
    )) throw new Error('Saved KitchenTrack entries could not be read. The device copy has not been removed.');
    return value as KitchenEntry[];
  }
  private async write(owner: KitchenOwner, entries: KitchenEntry[]) {
    const terminal = entries.filter(entry => isTerminal(entry.state)).slice(-20);
    const kept = entries.filter(entry => !isTerminal(entry.state)).concat(terminal);
    await this.deps.storage.setItem(kitchenOutboxKey(owner), JSON.stringify(kept));
    this.publish(owner, kept);
  }
  suspend = () => {
    this.generation += 1;
    this.session = null;
    this.snapshot = { owner: null, entries: [], error: null };
    this.listeners.forEach(listener => listener());
  };
  updateToken(token: string) {
    if (this.session) this.session = { ...this.session, token };
  }
  async activate(owner: KitchenOwner, token: string) {
    this.suspend();
    const session = { owner: { ...owner }, token, generation: this.generation };
    this.session = session;
    try {
      const entries = await this.serial(() => this.read(owner));
      if (this.session?.generation !== session.generation) return;
      this.publish(owner, entries);
      void this.replay();
    } catch (error) {
      if (this.session?.generation === session.generation) {
        this.publish(owner, [], error instanceof Error ? error.message : 'Could not read saved entries.');
      }
    }
  }
  async enqueue(input: Pick<KitchenEntry, 'entryId' | 'siteId' | 'recordDate' | 'recordId' | 'body'>) {
    const session = this.session;
    if (!session) throw new Error('Sign in to save KitchenTrack entries on this device.');
    const entry: KitchenEntry = {
      ...input, owner: { ...session.owner }, state: 'queued', createdAt: new Date().toISOString(),
      body: JSON.parse(JSON.stringify({
        ...input.body, mobileEntryId: input.entryId,
        ...(input.recordId !== null ? { mobileRecordDate: input.recordDate } : {}),
      })),
    };
    const persisted = await this.serial(async () => {
      if (this.session?.generation !== session.generation) throw new Error('The signed-in account changed. Save again after signing in.');
      const entries = await this.read(session.owner);
      const existing = entries.find(row => row.entryId === entry.entryId);
      if (existing) {
        if (JSON.stringify(existing.body) !== JSON.stringify(entry.body)
          || existing.siteId !== entry.siteId || existing.recordId !== entry.recordId
          || existing.recordDate !== entry.recordDate) {
          throw new Error('A saved entry identifier cannot be reused for different readings.');
        }
        return existing;
      }
      if (entries.some(row => !isTerminal(row.state)
        && row.siteId === entry.siteId && row.recordDate === entry.recordDate)) {
        throw new Error('This diary already has a saved device entry. Review its delivery state before saving again.');
      }
      await this.write(session.owner, entries.concat(entry));
      return entry;
    });
    void this.replay();
    return persisted;
  }
  async retry(entryId: string) {
    const owner = this.session?.owner;
    if (!owner) return;
    await this.serial(async () => {
      const entries = await this.read(owner);
      await this.write(owner, entries.map(entry =>
        entry.entryId === entryId && entry.state === 'failed'
          ? { ...entry, state: 'queued', error: undefined } : entry));
    });
    void this.replay();
  }
  /**
   * Turn a rejected (failed) entry back into an editable draft. Before
   * anything changes, `wasReceived` asks the server whether it already applied
   * this entry for this user. If it did, the entry is recorded as sent and
   * nothing is restored, so an acknowledged reading is never re-entered or
   * rewritten. Otherwise the entry becomes 'restored': it is never sent, its
   * original payload is kept unchanged on the device, and a copy is returned
   * for the form to re-check against the latest diary and controls. The form
   * saves under a new entry identifier.
   */
  async restoreToDraft(entryId: string, wasReceived: (entry: KitchenEntry) => Promise<boolean>): Promise<KitchenEntry> {
    const session = this.session;
    if (!session) throw new Error('Sign in to restore saved KitchenTrack entries.');
    const before = (await this.serial(() => this.read(session.owner))).find(row => row.entryId === entryId);
    if (!before || before.state !== 'failed') throw new Error('Only a failed device entry can be restored for editing.');
    // The receipt check is a network call, so it runs outside the storage lock.
    const received = await wasReceived(JSON.parse(JSON.stringify(before)));
    return this.serial(async () => {
      if (this.session?.generation !== session.generation) throw new Error('The signed-in account changed. Nothing was restored.');
      const entries = await this.read(session.owner);
      const current = entries.find(row => row.entryId === entryId);
      if (!current || current.state !== 'failed' || JSON.stringify(current.body) !== JSON.stringify(before.body)) {
        throw new Error('This entry changed while it was being restored. Nothing was restored.');
      }
      if (received) {
        await this.write(session.owner, entries.map(row =>
          row.entryId === entryId ? { ...row, state: 'sent', error: undefined } : row));
        throw new Error('The server already recorded these readings, so they were not restored. Review today’s diary instead.');
      }
      await this.write(session.owner, entries.map(row =>
        row.entryId === entryId ? { ...row, state: 'restored', error: undefined } : row));
      return JSON.parse(JSON.stringify(current)) as KitchenEntry;
    });
  }
  async removeFailed(entryId: string) {
    const owner = this.session?.owner;
    if (!owner) return;
    await this.serial(async () => {
      const entries = await this.read(owner);
      await this.write(owner, entries.filter(entry => entry.entryId !== entryId || entry.state !== 'failed'));
    });
  }
  replay = (): Promise<void> => {
    if (this.replaying) return this.replaying;
    const session = this.session;
    this.replaying = this.drain().catch(error => {
      if (session && this.session?.generation === session.generation) this.publish(session.owner, this.snapshot.entries,
        error instanceof Error ? error.message : 'Could not update saved entries.');
    }).finally(() => {
      this.replaying = null;
      if (this.session && this.session.generation !== session?.generation) void this.replay();
    });
    return this.replaying;
  };
  private async drain() {
    const session = this.session;
    if (!session) return;
    while (this.session?.generation === session.generation) {
      const entry = await this.serial(async () => {
        if (this.session?.generation !== session.generation) return undefined;
        const entries = await this.read(session.owner);
        const next = entries.find((row, index) => (row.state === 'queued' || row.state === 'sending')
          && !entries.slice(0, index).some(older =>
            older.state === 'failed' && older.siteId === row.siteId && older.recordDate === row.recordDate));
        if (!next) return undefined;
        next.state = 'sending';
        await this.write(session.owner, entries);
        return { ...next };
      });
      if (!entry || this.session?.generation !== session.generation) return;
      let state: KitchenDeliveryState = 'sent';
      let message: string | undefined;
      try {
        // Bind every attempt to the original validated session, never a later login.
        await this.deps.send(entry, this.session.token);
      } catch (error) {
        const status = typeof error === 'object' && error !== null && 'status' in error
          ? Number(error.status) : 0;
        state = !status || status === 401 || status === 408 || status === 429 || status >= 500 ? 'queued' : 'failed';
        message = status === 401 ? 'Sign in again to send these saved readings.'
          : error instanceof Error ? error.message.slice(0, 240) : 'Could not send this entry.';
      }
      if (state === 'sent' && this.session?.generation === session.generation) {
        // Refresh the loaded diary before enabling another edit. A failed
        // refresh cannot turn an acknowledged server write into an unsent one.
        await this.deps.onSent().catch(() => {});
      }
      await this.serial(async () => {
        const entries = await this.read(session.owner);
        await this.write(session.owner, entries.map(row =>
          row.entryId === entry.entryId ? { ...row, state, error: message } : row));
      });
      if (state === 'queued') return;
    }
  }
}