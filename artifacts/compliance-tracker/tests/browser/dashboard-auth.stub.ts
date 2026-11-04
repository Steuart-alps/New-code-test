// Harness stand-in for "@/context/auth-context" in the dashboard harness: a
// signed-in business admin with every module, so the page's real apiFetch and
// generated hooks run unchanged against the intercepted API.
export function useAuth() {
  return {
    activeClientId: null,
    user: { id: 1, name: "Harness Admin", role: "client_admin" },
    services: "all",
    hasService: () => true,
  };
}
export function useCanAdmin() {
  return false;
}
export function useIsMaintenanceManager() {
  return false;
}
