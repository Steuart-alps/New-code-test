// Harness stand-in for "@/context/auth-context" in the daily checklist card
// harness: a signed-in staff user. The card's apiFetch calls run unchanged
// against the intercepted API.
export function useAuth() {
  return { activeClientId: null, user: { id: 1, name: "Harness User", role: "client_staff" }, hasService: () => true };
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
