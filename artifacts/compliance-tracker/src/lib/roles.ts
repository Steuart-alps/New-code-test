/**
 * What each stored role is called in the app. Businesses never see the word
 * "Consultant": to them a consultant who belongs to their business (an older
 * self-signup) is one of its Owners.
 */
export function roleLabel(role: string, viewerIsConsultant: boolean): string {
  switch (role) {
    case "consultant": return viewerIsConsultant ? "Consultant" : "Owner";
    case "client_admin": return "Owner";
    case "client_manager": return "Manager";
    case "client_staff": return "Staff";
    case "client_viewer": return "Viewer";
    default: return role;
  }
}

/** Picked in the role list: Staff with the Maintenance manager switch on. */
export const MAINTENANCE_MANAGER_CHOICE = "maintenance_manager";

/** What each choice in the role list can do, in the order the list shows them. */
export const ROLE_DESCRIPTIONS: Record<string, string> = {
  consultant: "ALPS or an outside adviser who looks after several businesses. Only consultants see this role.",
  client_admin: "Full control of the business: billing, users, sites, departments, settings and every record. Can change older, locked records by giving a reason.",
  client_manager: "Head of department. Looks after their department, or every department if the Owner chooses: adds and removes Staff and Viewers there, sees and records everything there, runs FixTrack and contractor emails, and gets that department's summaries. No billing or settings.",
  [MAINTENANCE_MANAGER_CHOICE]: "Staff with full FixTrack access and the contractor emails.",
  client_staff: "Records checks and logs for their department. Can change a daily record on the day and the day after.",
  client_viewer: "Read-only. Sees their department's records but can't change anything. Suits an auditor or head office.",
};

export function roleChoiceLabel(choice: string, viewerIsConsultant: boolean): string {
  return choice === MAINTENANCE_MANAGER_CHOICE ? "Maintenance manager" : roleLabel(choice, viewerIsConsultant);
}
