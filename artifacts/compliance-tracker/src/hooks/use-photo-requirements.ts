import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { getApiErrorMessage } from "@/lib/api";

export interface PhotoRequirement {
  required: boolean;
  minPhotos: number;
}

const NO_REQUIREMENTS: Record<string, PhotoRequirement> = {};

export function usePhotoRequirements() {
  const { user, activeClientId } = useAuth();
  const request = useActiveClientApi();
  const query = useQuery<Record<string, PhotoRequirement>, Error>({
    queryKey: ["photo-requirements", user?.id, activeClientId],
    enabled: Boolean(user && activeClientId),
    retry: false,
    queryFn: async () => {
      const response = await request("/photos/requirements");
      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response, "Could not load photo requirements."));
      }
      const rows: unknown = await response.json();
      if (!Array.isArray(rows)) throw new Error("Invalid photo requirements response.");
      const requirements: Record<string, PhotoRequirement> = {};
      for (const row of rows) {
        if (!row || typeof row.entity_type !== "string" || typeof row.required !== "boolean"
          || !Number.isInteger(row.min_photos) || row.min_photos < 1 || row.min_photos > 10) {
          throw new Error("Invalid photo requirement. Please retry.");
        }
        requirements[row.entity_type] = { required: row.required, minPhotos: row.min_photos };
      }
      return requirements;
    },
  });
  return {
    requirements: query.data ?? NO_REQUIREMENTS,
    isLoading: query.isPending,
    error: query.error,
    retry: () => { void query.refetch(); },
  };
}