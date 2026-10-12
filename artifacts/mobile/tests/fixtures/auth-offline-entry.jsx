import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { listSites, setBaseUrl } from '@workspace/api-client-react';
import { AuthProvider, useAuth } from '../../lib/auth';
import { apiFetch } from '../../lib/api';
import { foreground, secureStore } from './auth-cache-native';

// The test seeds the device's SecureStore before the app starts.
for (const [key, value] of Object.entries(window.__seedSecureStore ?? {})) secureStore.set(key, value);
setBaseUrl('https://mobile-cache.test');

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Session() {
  const auth = useAuth();
  useEffect(() => {
    window.offlineHarness = {
      auth, secureStore, foreground,
      apiSites: () => apiFetch('/api/sites').then(() => 'ok', (error) => `error ${error.status ?? 'network'}`),
      generatedSites: () => listSites().then(() => 'ok', (error) => `error ${error.status ?? 'network'}`),
    };
    window.harnessReady = true;
  }, [auth]);
  if (auth.isLoading) return <div data-testid="account">Restoring session</div>;
  return <div data-testid="account">
    {auth.user ? `Account ${auth.user.clientId}${auth.isOffline ? ' (offline)' : ''} services:${JSON.stringify(auth.services)}` : 'Signed out'}
  </div>;
}
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><AuthProvider><Session /></AuthProvider></QueryClientProvider>,
);
