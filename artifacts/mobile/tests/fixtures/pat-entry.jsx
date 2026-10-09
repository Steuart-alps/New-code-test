import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import PatScreen from '../../app/checks/pat';
import { alerts } from './pat-native';

const client = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
});
function Harness() {
  const shared = useQueryClient();
  useEffect(() => {
    window.patHarness = {
      alerts,
      // Equivalent of the screen's pull-to-refresh, without native gestures.
      refresh: () => Promise.all([
        shared.invalidateQueries({ queryKey: ['pat-appliances'] }),
        shared.invalidateQueries({ queryKey: ['pat-tests'] }),
      ]),
    };
    window.harnessReady = true;
  }, [shared]);
  return <PatScreen />;
}
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><Harness /></QueryClientProvider>,
);
