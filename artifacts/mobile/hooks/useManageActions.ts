import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { hubActionsFrom, moduleActionsFrom, sitesFrom } from '@/components/compliance-actions-logic';

/** Query key prefix for both action lists; invalidate it after any change. */
export const MANAGE_ACTIONS_KEY = ['manage-actions'] as const;

/** Unresolved module actions across every track (GET /track-actions?status=unresolved). */
export function useModuleActions() {
  return useQuery({
    queryKey: [...MANAGE_ACTIONS_KEY, 'module'],
    queryFn: async () => moduleActionsFrom(await apiFetch('/api/track-actions?status=unresolved')),
  });
}

/** The Compliance Hub's corrective actions (GET /compliance-hub/actions). */
export function useHubActions() {
  return useQuery({
    queryKey: [...MANAGE_ACTIONS_KEY, 'hub'],
    queryFn: async () => hubActionsFrom(await apiFetch('/api/compliance-hub/actions')),
  });
}

/** Sites the account can see, for names and the site filter. */
export function useActionSites() {
  return useQuery({
    queryKey: [...MANAGE_ACTIONS_KEY, 'sites'],
    queryFn: async () => sitesFrom(await apiFetch('/api/sites')),
    staleTime: 5 * 60_000,
  });
}
