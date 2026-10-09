import { csvCell } from "./csv";

export type MatrixCertificate = {
  /** Record id; only used to break ties between same-day certificates. */
  id?: number;
  /** Stable roster identity. Null/absent on legacy, name-only records. */
  staff_roster_id?: number | null;
  staff_name: string;
  training_type: string | null;
  completed_date: string;
  expiry_date: string | null;
  site_id: number | null;
};

export type MatrixStaffMember = {
  id: number;
  name: string;
  site_id: number | null;
  site_name?: string | null;
  active: boolean;
};

export type MatrixStatus = "Current" | "Expiring Soon" | "Expired" | "Missing";

export type MatrixRow = {
  /** Cell key prefix: the roster id as a string. */
  key: string;
  staffId: number;
  name: string;
  /** Display/CSV label; disambiguated when several rows share a name. */
  label: string;
};

export type TrainingMatrix = {
  rows: MatrixRow[];
  types: string[];
  /** Keyed by `matrixCellKey(row, type)`. */
  cells: Map<string, { status: MatrixStatus; expiryDate: string | null }>;
  /**
   * In-scope legacy certificates (no roster id) whose staff name matches no
   * active roster member in scope, or several. They are left out of the
   * matrix rather than guessed, and the caller reports them.
   */
  unmatchedCertificates: MatrixCertificate[];
};

function dateAtLocalMidnight(value: string): Date {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function certificateStatus(expiryDate: string | null, today = new Date()): MatrixStatus {
  if (!expiryDate) return "Current";

  const startOfToday = new Date(today);
  startOfToday.setHours(0, 0, 0, 0);
  const expiry = dateAtLocalMidnight(expiryDate);
  if (expiry < startOfToday) return "Expired";

  const inThirtyDays = new Date(startOfToday);
  inThirtyDays.setDate(inThirtyDays.getDate() + 30);
  return expiry <= inThirtyDays ? "Expiring Soon" : "Current";
}

/** Case-, width- and whitespace-insensitive form used only for legacy matching. */
export function normaliseStaffName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-GB");
}

export function matrixCellKey(row: Pick<MatrixRow, "key">, type: string): string {
  return `${row.key}\u0000${type}`;
}

function isNewer(candidate: MatrixCertificate, existing: MatrixCertificate): boolean {
  const a = candidate.completed_date.slice(0, 10);
  const b = existing.completed_date.slice(0, 10);
  if (a !== b) return a > b;
  return (candidate.id ?? -Infinity) > (existing.id ?? -Infinity);
}

/**
 * Build the staff x training-type matrix from one tenant's API responses.
 *
 * Rows are active roster members in the selected site scope, identified by
 * roster id, so two people with the same name stay separate. Certificates
 * attach by `staff_roster_id`; a legacy record without one attaches by name
 * only when exactly one in-scope active roster member has that normalised
 * name. Ambiguous or unknown legacy records go to `unmatchedCertificates`.
 */
export function buildTrainingMatrix(
  certificates: MatrixCertificate[],
  staff: MatrixStaffMember[],
  siteId: string,
  today = new Date(),
): TrainingMatrix {
  const matchesSite = <T extends { site_id: number | null }>(row: T) =>
    siteId === "all" || String(row.site_id) === siteId;
  const scopedCertificates = certificates.filter(matchesSite);
  const scopedStaff = staff.filter(member => member.active && matchesSite(member));

  const byId = new Map<number, MatrixStaffMember>();
  const byName = new Map<string, MatrixStaffMember[]>();
  for (const member of scopedStaff) {
    if (byId.has(member.id)) continue;
    byId.set(member.id, member);
    const name = normaliseStaffName(member.name);
    byName.set(name, [...(byName.get(name) ?? []), member]);
  }

  const members = Array.from(byId.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
    || (a.site_name ?? "").localeCompare(b.site_name ?? "")
    || a.id - b.id);
  const rows: MatrixRow[] = members.map(member => {
    const shared = (byName.get(normaliseStaffName(member.name)) ?? []).length > 1;
    const label = shared
      ? `${member.name} (${member.site_name || "no site"}, roster #${member.id})`
      : member.name;
    return { key: String(member.id), staffId: member.id, name: member.name, label };
  });

  const types = Array.from(new Set(scopedCertificates.map(record => record.training_type || "Other")))
    .sort((a, b) => a.localeCompare(b));

  const unmatchedCertificates: MatrixCertificate[] = [];
  const latestCertificates = new Map<string, MatrixCertificate>();
  for (const record of scopedCertificates) {
    let owner: MatrixStaffMember | undefined;
    if (record.staff_roster_id != null) {
      // A linked record belongs to that person only. If they are inactive or
      // outside the selected site they have no row, and the record is skipped.
      owner = byId.get(record.staff_roster_id);
      if (!owner) continue;
    } else {
      const candidates = byName.get(normaliseStaffName(record.staff_name)) ?? [];
      if (candidates.length !== 1) {
        unmatchedCertificates.push(record);
        continue;
      }
      owner = candidates[0];
    }
    const key = `${owner.id}\u0000${record.training_type || "Other"}`;
    const existing = latestCertificates.get(key);
    if (!existing || isNewer(record, existing)) latestCertificates.set(key, record);
  }

  const cells = new Map<string, { status: MatrixStatus; expiryDate: string | null }>();
  for (const row of rows) {
    for (const type of types) {
      const record = latestCertificates.get(matrixCellKey(row, type));
      cells.set(matrixCellKey(row, type), record
        ? { status: certificateStatus(record.expiry_date, today), expiryDate: record.expiry_date }
        : { status: "Missing", expiryDate: null });
    }
  }

  return { rows, types, cells, unmatchedCertificates };
}

/**
 * Serialize the same matrix shown by the download action. Every field is
 * quoted and formula-neutralised: staff names and training types are
 * user-entered, and quoting alone does not stop a spreadsheet evaluating them.
 */
export function trainingMatrixToCsv(
  matrix: TrainingMatrix,
  formatExpiryDate: (date: string) => string,
): string {
  const rows = [
    ["Staff member", ...matrix.types],
    ...matrix.rows.map(row => [
      row.label,
      ...matrix.types.map(type => {
        const value = matrix.cells.get(matrixCellKey(row, type));
        if (!value) return "Missing";
        return value.expiryDate
          ? `${value.status} (${formatExpiryDate(value.expiryDate)})`
          : value.status;
      }),
    ]),
  ];
  return rows.map(row => row.map(csvCell).join(","))
    .join("\r\n");
}
