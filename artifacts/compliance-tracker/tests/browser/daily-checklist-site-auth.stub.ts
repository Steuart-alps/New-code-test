// Harness stand-in for "@/context/auth-context" in the daily checklist site
// harness: a signed-in user of client 1 (staff unless the harness page's
// ?role= says otherwise), whose department comes from ?dept= (none when absent).
const query = new URLSearchParams(window.location.search);
const dept = Number(query.get("dept")) || null;
const role = query.get("role") ?? "client_staff";

export function useAuth() {
  return {
    activeClientId: null,
    user: { id: 1, name: "Harness User", role, clientId: 1, departmentId: dept },
    hasService: () => true,
  };
}
export function useCanAdmin() {
  return false;
}
export function useCanManageUsers() {
  return false;
}
export function useIsManager() {
  return false;
}
export function useCanEdit() {
  return true;
}
export function useIsConsultant() {
  return false;
}
export function useIsMaintenanceManager() {
  return false;
}
export function AuthProvider({ children }: { children: unknown }) {
  return children;
}
