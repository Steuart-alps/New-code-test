const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export const API_BASE = `${BASE}/api`;

export async function apiFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  return res;
}
