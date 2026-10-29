// Harness stand-in for "@/context/auth-context" in the daily checklist site
// harness: a signed-in staff user of client 1, whose department comes from
// the harness page's ?dept= (none when absent).
const dept = Number(new URLSearchParams(window.location.search).get("dept")) || null;

export function useAuth() {
  return {
    activeClientId: null,
    user: { id: 1, name: "Harness User", role: "client_staff", clientId: 1, departmentId: dept },
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
