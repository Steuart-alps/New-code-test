import { useQuery } from "@tanstack/react-query";
import { apiFetch, getApiErrorMessage } from "@/lib/api";
import { useAuth } from "@/context/auth-context";

export interface TrackOwner {
  id: number;
  module: string;
  siteId: number | null;
  userId: number;
  userName: string;
  eligible: boolean;
}

export interface TrackOwnersResponse {
  /**
   * Every track. `enabled`: the business has it. `chosen`: it was picked in
   * setup (Modules to start with), is one every business has, or already has
   * an owner; every enabled track when nothing was picked. Older servers
   * leave `chosen` out, which counts as chosen.
   */
  modules: { key: string; label: string; enabled: boolean; chosen?: boolean }[];
  owners: TrackOwner[];
  sites: { id: number; name: string }[];
  users: { id: number; name: string; email: string; role: string }[];
  defaultRecipients: { id: number; name: string }[];
}

/** GET /track-owners, shared by Settings > Departments and owners and > Reminders. */
export function useTrackOwners() {
  const { user, activeClientId } = useAuth();
  const queryKey = ["track-owners", user?.id ?? null, activeClientId ?? null];
  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<TrackOwnersResponse> => {
      const response = await apiFetch("/track-owners");
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Couldn't load track owners"));
      return response.json();
    },
  });
  return { ...query, queryKey };
}

/**
 * Whether Settings should list a track by default. Keys that aren't tracks
 * (e.g. "tasks", "contractors") are always listed, as is everything while
 * the list is loading or couldn't load.
 */
export function isChosenTrack(data: TrackOwnersResponse | undefined, key: string): boolean {
  const track = data?.modules.find((module) => module.key === key);
  if (!track) return true;
  return track.enabled && track.chosen !== false;
}
