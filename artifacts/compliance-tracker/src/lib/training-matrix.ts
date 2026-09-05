export type MatrixCertificate = {
  staff_name: string;
  training_type: string | null;
  completed_date: string;
  expiry_date: string | null;
  site_id: number | null;
};

export type MatrixStaffMember = {
  name: string;
  site_id: number | null;
  active: boolean;
};

export type MatrixStatus = "Current" | "Expiring Soon" | "Expired" | "Missing";

export type TrainingMatrix = {
  staffNames: string[];
  types: string[];
  cells: Map<string, { status: MatrixStatus; expiryDate: string | null }>;
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
  const staffNames = Array.from(new Set(scopedStaff.map(member => member.name)))
    .sort((a, b) => a.localeCompare(b));
  const types = Array.from(new Set(scopedCertificates.map(record => record.training_type || "Other")))
    .sort((a, b) => a.localeCompare(b));

  const latestCertificates = new Map<string, MatrixCertificate>();
  for (const record of scopedCertificates) {
    const key = `${record.staff_name}\u0000${record.training_type || "Other"}`;
    const existing = latestCertificates.get(key);
    if (!existing || record.completed_date > existing.completed_date) {
      latestCertificates.set(key, record);
    }
  }

  const cells = new Map<string, { status: MatrixStatus; expiryDate: string | null }>();
  for (const staffName of staffNames) {
    for (const type of types) {
      const record = latestCertificates.get(`${staffName}\u0000${type}`);
      cells.set(`${staffName}\u0000${type}`, record
        ? { status: certificateStatus(record.expiry_date, today), expiryDate: record.expiry_date }
        : { status: "Missing", expiryDate: null });
    }
  }

  return { staffNames, types, cells };
}