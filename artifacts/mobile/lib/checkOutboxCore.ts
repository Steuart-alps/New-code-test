/**
 * Device outbox for check submissions other than KitchenTrack temperatures:
 * the AM/PM daily checklist and the fire, legionella, hot tub, PAT, incident
 * and pool check forms, TreeTrack inspections and GreenTrack machine records
 * (defects, fuel logs, service records, PUWER inspections), KitchenTrack cleaning
 * schedule saves, plus the staff actions that work offline (FixTrack issue
 * reports and notes, "Mark done" on today's tasks, SafeTrack and DocTrack
 * acknowledgements). Same contract as kitchenOutboxCore: the submission and a
 * stable entry ID are written to device storage before the first HTTP
 * attempt, replays send the identical body, and the server recognises a
 * replay of an entry it already applied (clientEntryId), so automatic and
 * manual retries can never create a duplicate record.
 *
 * Photos are not part of these bodies; forms with photo evidence keep the
 * upload as a separate stage (see mobile-staged-photo-evidence).
 *
 * Import-free so tests can load it directly with Node.
 */
export interface CheckOwner { clientId: number; userId: number }
export type CheckDeliveryState = 'queued' | 'sending' | 'sent' | 'failed';
export type CheckKind = 'daily-checklist' | 'fire-check' | 'legionella-check' | 'hot-tub-check' | 'pat-test' | 'incident' | 'pool-check'
  | 'premises-inspection' | 'tree-inspection' | 'room-check' | 'pest-activity' | 'pest-visit'
  | 'swim-surveillance' | 'swim-first-aid' | 'swim-incident' | 'green-defect' | 'green-fuel' | 'green-service' | 'green-puwer'
  | 'kitchen-probe' | 'kitchen-weekly' | 'cleaning-log'
  | 'bike-hire' | 'bike-service'
  | 'fix-issue' | OfflineActionKind;
/** Actions on an existing server record (path carries its ID): one unsent entry per target. */
export type OfflineActionKind = 'fix-note' | 'task-completion' | 'safe-ack' | 'doc-ack';
export type DeliveryRejection = 'conflict' | 'rejected';

/** Kinds whose entries are independent records (each gets its own scope). */
export const RECORD_KINDS: readonly CheckKind[] = ['fire-check', 'legionella-check', 'hot-tub-check', 'pat-test', 'incident', 'pool-check',
  'premises-inspection', 'tree-inspection', 'room-check', 'pest-activity', 'pest-visit',
  'swim-surveillance', 'swim-first-aid', 'swim-incident', 'green-defect', 'green-fuel', 'green-service', 'green-puwer',
  'kitchen-probe', 'kitchen-weekly', 'cleaning-log',
  'bike-hire', 'bike-service', 'fix-issue'];
export const RECORD_PATHS: Record<Exclude<CheckKind, 'daily-checklist' | OfflineActionKind>, string> = {
  'fire-check': '/api/fire-safety',
  'legionella-check': '/api/legionella',
  'hot-tub-check': '/api/hot-tub',
  'pat-test': '/api/pat-track/tests',
  incident: '/api/incidents',
  'pool-check': '/api/pool-track',
  'premises-inspection': '/api/premises-track',
  'tree-inspection': '/api/tree-track',
  'room-check': '/api/room-track/checks',
  'pest-activity': '/api/pest-track/activity',
  'pest-visit': '/api/pest-track/visits',
  'swim-surveillance': '/api/swim-track/surveillance',
  'swim-first-aid': '/api/swim-track/first-aid',
  'swim-incident': '/api/swim-track/incidents',
  'green-defect': '/api/green-track/defects',
  'green-fuel': '/api/green-track/fuel-logs',
  'green-service': '/api/green-track/service-records',
  'green-puwer': '/api/green-track/puwer-inspections',
  'kitchen-probe': '/api/kitchen-weekly/probe',
  'kitchen-weekly': '/api/kitchen-weekly/weekly',
  // Upserts the schedule for its kitchen, frequency and period; entries are
  // delivered oldest first, so a later save never lands before an earlier one.
  'cleaning-log': '/api/kitchen-cleaning/logs',
  'bike-hire': '/api/bike-track/hires',
  'bike-service': '/api/bike-track/services',
  'fix-issue': '/api/fix-track/issues',
};
export type SafeTrackDocument = 'risk-assessments' | 'sops' | 'handbook';
/** Path and scope of each offline action: one unsent entry per target, or per entry when perEntry. */
export const ACTION_TARGETS = {
  // Several notes may wait for one issue: each note is its own scope.
  fixNote: (issueId: number) => ({ path: `/api/fix-track/issues/${issueId}/notes`, scopeKey: `fix-note:${issueId}`, perEntry: true }),
  taskCompletion: (taskId: number, date: string) => ({ path: `/api/tasks/${taskId}/complete`, scopeKey: `task-completion:${taskId}:${date}` }),
  safeAck: (sub: SafeTrackDocument, id: number) => ({ path: `/api/safe-track/${sub}/${id}/self-acknowledge`, scopeKey: `safe-ack:${sub}:${id}` }),
  docAck: (documentId: number) => ({ path: `/api/doc-track/documents/${documentId}/acknowledge`, scopeKey: `doc-ack:${documentId}` }),
};

/** Query keys to refresh once an entry of this kind has been delivered. */
export function deliveredQueryKeys(kind: CheckKind): string[][] {
  switch (kind) {
    case 'daily-checklist': return [['daily-checklist'], ['daily-overview']];
    case 'fire-check': return [['fire-status'], ['track-controls'], ['dashboard-summary']];
    case 'legionella-check': return [['water-status'], ['track-controls'], ['dashboard-summary']];
    case 'hot-tub-check': return [['hot-tub-status'], ['track-controls'], ['dashboard-summary']];
    case 'pat-test': return [['pat-tests'], ['pat-appliances'], ['dashboard-summary']];
    case 'incident': return [['incidents'], ['dashboard-summary']];
    case 'pool-check': return [['pool-checks'], ['track-controls'], ['dashboard-summary']];
    case 'premises-inspection': return [['premises-inspections'], ['dashboard-summary']];
    case 'tree-inspection': return [['tree-inspections'], ['tree-status'], ['dashboard-summary']];
    case 'room-check': return [['room-track-checks'], ['dashboard-summary']];
    case 'pest-activity': return [['pest-activity'], ['dashboard-summary']];
    case 'pest-visit': return [['pest-visits'], ['dashboard-summary']];
    case 'swim-surveillance': return [['swim-surveillance'], ['track-controls'], ['dashboard-summary']];
    case 'swim-first-aid': return [['swim-first-aid'], ['track-controls'], ['dashboard-summary']];
    case 'swim-incident': return [['swim-incidents'], ['dashboard-summary']];
    case 'green-defect': return [['green-records', 'defect'], ['dashboard-summary']];
    case 'green-fuel': return [['green-records', 'fuel'], ['dashboard-summary']];
    case 'green-service': return [['green-records', 'service'], ['dashboard-summary']];
    case 'green-puwer': return [['green-records', 'puwer'], ['dashboard-summary']];
    case 'kitchen-probe': return [['kitchen-probe-checks'], ['dashboard-summary']];
    case 'kitchen-weekly': return [['kitchen-weekly-reviews'], ['dashboard-summary']];
    case 'cleaning-log': return [['kitchen-cleaning-log'], ['kitchen-cleaning-history'], ['dashboard-summary']];
    case 'bike-hire': return [['bike-hires'], ['bike-fleet'], ['dashboard-summary']];
    case 'bike-service': return [['bike-services'], ['bike-services-latest'], ['dashboard-summary']];
    case 'fix-issue': return [['fix-track-issues'], ['fix-track-issues-all'], ['dashboard-summary']];
    case 'fix-note': return [['fix-track-issue'], ['fix-track-issues'], ['fix-track-issues-all']];
    case 'task-completion': return [['tasks']];
    case 'safe-ack': return [['safetrack-acks']];
    case 'doc-ack': return [['doc-track-my-acknowledgements'], ['doctrack-documents'], ['traintrack-records']];
  }
}
export interface CheckEntry {
  entryId: string;
  owner: CheckOwner;
  kind: CheckKind;
  /** API path the body is POSTed to. Only allowlisted shapes are accepted. */
  path: string;
  /** One unsent entry per scope (e.g. one AM checklist per site and day). */
  scopeKey: string;
  label: string;
  body: Record<string, unknown>;
  state: CheckDeliveryState;
  createdAt: string;
  error?: string;
  /** Why a 'failed' entry was not accepted: a 409 conflict or another rejection. */
  rejection?: DeliveryRejection;
  /** When the server confirmed a 'sent' entry. */
  sentAt?: string;
}
export interface CheckOutboxSnapshot {
  owner: CheckOwner | null;
  entries: CheckEntry[];
  error: string | null;
}
interface OutboxDependencies {
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
  };
  /** Resolves with the server response body (kept briefly for the screen that sent it). */
  send(entry: CheckEntry, token: string): Promise<unknown>;
  onSent(entry: CheckEntry): Promise<void>;
}

const PATHS: Record<CheckKind, RegExp> = {
  'daily-checklist': /^\/api\/daily-checklists\/\d{1,9}\/\d{4}-\d{2}-\d{2}\/(am|pm)$/,
  'fire-check': /^\/api\/fire-safety$/,
  'legionella-check': /^\/api\/legionella$/,
  'hot-tub-check': /^\/api\/hot-tub$/,
  'pat-test': /^\/api\/pat-track\/tests$/,
  incident: /^\/api\/incidents$/,
  'pool-check': /^\/api\/pool-track$/,
  'premises-inspection': /^\/api\/premises-track$/,
  'tree-inspection': /^\/api\/tree-track$/,
  'room-check': /^\/api\/room-track\/checks$/,
  'pest-activity': /^\/api\/pest-track\/activity$/,
  'pest-visit': /^\/api\/pest-track\/visits$/,
  'swim-surveillance': /^\/api\/swim-track\/surveillance$/,
  'swim-first-aid': /^\/api\/swim-track\/first-aid$/,
  'swim-incident': /^\/api\/swim-track\/incidents$/,
  'green-defect': /^\/api\/green-track\/defects$/,
  'green-fuel': /^\/api\/green-track\/fuel-logs$/,
  'green-service': /^\/api\/green-track\/service-records$/,
  'green-puwer': /^\/api\/green-track\/puwer-inspections$/,
  'kitchen-probe': /^\/api\/kitchen-weekly\/probe$/,
  'kitchen-weekly': /^\/api\/kitchen-weekly\/weekly$/,
  'cleaning-log': /^\/api\/kitchen-cleaning\/logs$/,
  'bike-hire': /^\/api\/bike-track\/hires$/,
  'bike-service': /^\/api\/bike-track\/services$/,
  'fix-issue': /^\/api\/fix-track\/issues$/,
  'fix-note': /^\/api\/fix-track\/issues\/\d{1,9}\/notes$/,
  'task-completion': /^\/api\/tasks\/\d{1,9}\/complete$/,
  'safe-ack': /^\/api\/safe-track\/(risk-assessments|sops|handbook)\/\d{1,9}\/self-acknowledge$/,
  'doc-ack': /^\/api\/doc-track\/documents\/\d{1,9}\/acknowledge$/,
};
const ENTRY_ID = /^[A-Za-z0-9_-]{12,100}$/;
const READ_ERROR = 'Saved checks on this device could not be read. The device copy has not been removed.';

export const checkOutboxKey = (owner: CheckOwner) =>
  `complytrack:check-outbox:v1:${owner.clientId}:${owner.userId}`;
const sameOwner = (a: CheckOwner, b: CheckOwner) =>
  a.clientId === b.clientId && a.userId === b.userId;

/** Network failures, an expired session, timeouts, rate limits and server
 *  errors keep the entry queued; any other rejection needs the user. */
export function isRetryableStatus(status: number): boolean {
  return !status || status === 401 || status === 408 || status === 429 || status >= 500;
}

/** Credentials stay in memory. Disk writes finish before the first HTTP attempt. */
export class CheckOutbox {
  private session: { owner: CheckOwner; token: string; generation: number } | null = null;
  private generation = 0;
  private lock: Promise<unknown> = Promise.resolve();
  private replaying: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private snapshot: CheckOutboxSnapshot = { owner: null, entries: [], error: null };
  // Server responses of recent deliveries, in memory only (e.g. the result the
  // server recorded), for the screen that is waiting on that entry.
  private responses = new Map<string, unknown>();
  constructor(private deps: OutboxDependencies) {}

  getSnapshot = () => this.snapshot;
  takeResponse = (entryId: string): unknown => {
    const response = this.responses.get(entryId);
    this.responses.delete(entryId);
    return response;
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(owner: CheckOwner, entries: CheckEntry[], error: string | null = null) {
    if (!this.session || !sameOwner(owner, this.session.owner)) return;
    this.snapshot = { owner, entries, error };
    this.listeners.forEach(listener => listener());
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const operation = this.lock.then(fn, fn);
    this.lock = operation.catch(() => {});
    return operation;
  }
  private async read(owner: CheckOwner): Promise<CheckEntry[]> {
    const raw = await this.deps.storage.getItem(checkOutboxKey(owner));
    if (!raw) return [];
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error(READ_ERROR); }
    if (!Array.isArray(value) || value.some(entry =>
      !entry || typeof entry !== 'object'
      || !entry.owner || !sameOwner(entry.owner, owner)
      || typeof entry.entryId !== 'string' || !ENTRY_ID.test(entry.entryId)
      || !(entry.kind in PATHS) || typeof entry.path !== 'string' || !PATHS[entry.kind as CheckKind].test(entry.path)
      || typeof entry.scopeKey !== 'string' || typeof entry.label !== 'string'
      || !entry.body || typeof entry.body !== 'object' || Array.isArray(entry.body)
      || entry.body.clientEntryId !== entry.entryId
      || !['queued', 'sending', 'sent', 'failed'].includes(entry.state)
      || typeof entry.createdAt !== 'string'
    )) throw new Error(READ_ERROR);
    return value as CheckEntry[];
  }
  private async write(owner: CheckOwner, entries: CheckEntry[]) {
    const sent = entries.filter(entry => entry.state === 'sent').slice(-20);
    const kept = entries.filter(entry => entry.state !== 'sent').concat(sent);
    await this.deps.storage.setItem(checkOutboxKey(owner), JSON.stringify(kept));
    this.publish(owner, kept);
  }
  suspend = () => {
    this.generation += 1;
    this.session = null;
    this.responses.clear();
    this.snapshot = { owner: null, entries: [], error: null };
    this.listeners.forEach(listener => listener());
  };
  updateToken(token: string) {
    if (this.session) this.session = { ...this.session, token };
  }
  async activate(owner: CheckOwner, token: string) {
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
        this.publish(owner, [], error instanceof Error ? error.message : 'Could not read saved checks.');
      }
    }
  }
  async enqueue(input: Pick<CheckEntry, 'entryId' | 'kind' | 'path' | 'scopeKey' | 'label' | 'body'>) {
    const session = this.session;
    if (!session) throw new Error('Sign in to save checks on this device.');
    if (!ENTRY_ID.test(input.entryId)) throw new Error('Invalid entry identifier.');
    if (!PATHS[input.kind]?.test(input.path)) throw new Error('This check cannot be saved on the device.');
    const entry: CheckEntry = {
      ...input, owner: { ...session.owner }, state: 'queued', createdAt: new Date().toISOString(),
      body: JSON.parse(JSON.stringify({ ...input.body, clientEntryId: input.entryId })),
    };
    const persisted = await this.serial(async () => {
      if (this.session?.generation !== session.generation) throw new Error('The signed-in account changed. Save again after signing in.');
      const entries = await this.read(session.owner);
      const existing = entries.find(row => row.entryId === entry.entryId);
      if (existing) {
        if (JSON.stringify(existing.body) !== JSON.stringify(entry.body) || existing.path !== entry.path) {
          throw new Error('A saved entry identifier cannot be reused for a different check.');
        }
        return existing;
      }
      if (entries.some(row => row.state !== 'sent' && row.scopeKey === entry.scopeKey)) {
        throw new Error('This check already has a saved device entry. Review its delivery state before saving again.');
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
          ? { ...entry, state: 'queued', error: undefined, rejection: undefined } : entry));
    });
    void this.replay();
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
        error instanceof Error ? error.message : 'Could not update saved checks.');
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
        const next = entries.find(row => row.state === 'queued' || row.state === 'sending');
        if (!next) return undefined;
        next.state = 'sending';
        await this.write(session.owner, entries);
        return { ...next };
      });
      if (!entry || this.session?.generation !== session.generation) return;
      let state: CheckDeliveryState = 'sent';
      let message: string | undefined;
      let rejection: DeliveryRejection | undefined;
      try {
        // Bind every attempt to the original validated session, never a later login.
        const response = await this.deps.send(entry, this.session.token);
        this.responses.set(entry.entryId, response);
        while (this.responses.size > 20) this.responses.delete(this.responses.keys().next().value as string);
      } catch (error) {
        const status = typeof error === 'object' && error !== null && 'status' in error
          ? Number(error.status) : 0;
        state = isRetryableStatus(status) ? 'queued' : 'failed';
        if (state === 'failed') rejection = status === 409 ? 'conflict' : 'rejected';
        message = status === 401 ? 'Sign in again to send this saved check.'
          : error instanceof Error ? error.message.slice(0, 240) : 'Could not send this check.';
      }
      if (state === 'sent' && this.session?.generation === session.generation) {
        await this.deps.onSent(entry).catch(() => {});
      }
      await this.serial(async () => {
        const entries = await this.read(session.owner);
        await this.write(session.owner, entries.map(row =>
          row.entryId === entry.entryId
            ? { ...row, state, error: message, rejection, sentAt: state === 'sent' ? new Date().toISOString() : undefined } : row));
      });
      if (state === 'queued') return;
    }
  }
}
