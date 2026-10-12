import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PatScreen from '../../app/checks/pat';
import ChecksScreen from '../../app/(tabs)/checks';
import { alerts, routerCalls } from './pat-native';

// ?screen=pat|checks picks the production screen to mount; ?services=a,b sets
// the client's enabled services (empty = none, omitted = pattrack only).
const params = new URLSearchParams(window.location.search);
if (params.has('services')) window.patServices = params.get('services').split(',').filter(Boolean);
const Screen = params.get('screen') === 'checks' ? ChecksScreen : PatScreen;

const client = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
});
function Harness() {
  useEffect(() => {
    window.patHarness = { alerts, routerCalls };
    window.harnessReady = true;
  }, []);
  return <Screen />;
}
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><Harness /></QueryClientProvider>,
);
