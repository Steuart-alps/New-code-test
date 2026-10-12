import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setAuthTokenGetter, setBaseUrl } from '@workspace/api-client-react';
import SiteControlsScreen from '../../app/controls/[module]';
import { pushes } from './track-controls-native';

// Mirrors app/_layout.tsx and lib/auth.tsx: an absolute API base and the
// signed-in bearer token, with no client id injected by the app.
setBaseUrl('https://controls-mobile.test');
setAuthTokenGetter(() => 'test-only-token');

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
window.controlsParams = JSON.parse(decodeURIComponent(location.hash.slice(1) || '{}'));
function Harness() {
  useEffect(() => {
    window.controlsHarness = { pushes };
    window.harnessReady = true;
  }, []);
  return <SiteControlsScreen />;
}
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><Harness /></QueryClientProvider>,
);
