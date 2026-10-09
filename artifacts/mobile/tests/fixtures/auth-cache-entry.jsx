import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '../../lib/auth';
import IncidentScreen from '../../app/checks/incident';
import { foreground, secureStore } from './auth-cache-native';

const client = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity }, mutations: { retry: false } },
});
function Session() {
  const auth = useAuth(), sharedClient = useQueryClient();
  useEffect(() => {
    window.cacheHarness = {
      auth, client: sharedClient, secureStore, foreground,
      async seedOtherModules(marker) {
        sharedClient.setQueryData(['fire-safety', auth.user.clientId], [{ name: marker, location: marker }]);
        sharedClient.setQueryData(['legionella'], [{ name: marker }]);
        sharedClient.setQueryData(['legacy-incidents'], [{ involvedName: marker }]);
        const mutation = sharedClient.getMutationCache().build(sharedClient, {
          mutationKey: ['saved-private-record'],
          mutationFn: async () => ({ involvedName: marker }),
        });
        await mutation.execute({});
      },
      async delayedQuery() {
        return sharedClient.fetchQuery({
          queryKey: ['delayed-private-record', auth.user.clientId],
          queryFn: async () => {
            const response = await fetch('https://mobile-cache.test/api/delayed', {
              headers: { Authorization: `Bearer account-${auth.user.clientId}` },
            });
            return response.json();
          },
        }).catch(() => {}); // clear() deliberately cancels this query
      },
      snapshot() {
        return {
          queries: sharedClient.getQueryCache().getAll().map(query => ({ key: query.queryKey, data: query.state.data })),
          mutations: sharedClient.getMutationCache().getAll().map(mutation => ({ key: mutation.options.mutationKey, data: mutation.state.data })),
        };
      },
    };
    window.harnessReady = true;
  }, [auth, sharedClient]);
  if (auth.isLoading) return <div>Restoring session</div>;
  return <div>
    <div data-testid="account">{auth.user ? `Account ${auth.user.clientId}` : 'Signed out'}</div>
    {auth.isAuthenticated && <IncidentScreen />}
  </div>;
}
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><AuthProvider><Session /></AuthProvider></QueryClientProvider>,
);