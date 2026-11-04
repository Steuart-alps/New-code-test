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

/** Picked in the role list: a Manager with the Maintenance manager switch on. */
export const MAINTENANCE_MANAGER_CHOICE = "maintenance_manager";

/** What each choice in the role list can do, in the order the list shows them. */
export const ROLE_DESCRIPTIONS: Record<string, string> = {
  consultant: "ALPS only. Sees every business on ComplyTrack. Businesses never see this role.",
  client_admin: "Full control of the business: billing, users, sites, departments, settings and every record. Can change older, locked records by giving a reason.",
  client_manager: "Head of department. Looks after one, several or all departments, as the Owner chooses: adds and removes Staff and Viewers there, sees and records everything there, runs FixTrack and contractor emails, and gets those departments' summaries. With several departments they switch between them at the top of the page. No billing or settings.",
  [MAINTENANCE_MANAGER_CHOICE]: "A Manager for maintenance: the same rights over the departments the Owner chooses (often all of them), plus every FixTrack job and the contractor emails.",
  client_staff: "Records checks and logs for their department. Can change a daily record on the day and the day after.",
  client_viewer: "Sees only their own training records, linked to their name on the staff roster, and signs them off. Nothing else in the app.",
};

export function roleChoiceLabel(choice: string, viewerIsConsultant: boolean): string {
  return choice === MAINTENANCE_MANAGER_CHOICE ? "Maintenance manager" : roleLabel(choice, viewerIsConsultant);
}
