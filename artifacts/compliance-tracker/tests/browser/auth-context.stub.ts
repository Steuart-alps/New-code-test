// Harness stand-in for "@/context/auth-context": a signed-in user with no
// consultant-selected tenant, so the uploader's real useActiveClientApi and
// apiFetch run unchanged against the intercepted API.
export function useAuth() {
  return { activeClientId: null, user: { id: 1, role: "client_admin" } };
}
