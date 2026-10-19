import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CleaningScreen from '../../app/checks/cleaning';
import { alerts, deviceStorage, pressAlertButton } from './cleaning-native';
import { activateOutbox, checkOutbox, outboxStorage, setOutboxQueryClient } from './cleaning-check-outbox-native';

const newClient = () => new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
});

function Harness() {
  // A restart drops everything held in memory (screen state and the query
  // cache); only device storage and the outbox's stored entries survive.
  const [mount, setMount] = useState(() => ({ key: 0, client: newClient() }));
  setOutboxQueryClient(mount.client);
  useEffect(() => {
    window.cleaningHarness = {
      alerts,
      pressAlertButton,
      deviceKeys: () => [...deviceStorage.keys()],
      deviceValue: (key) => deviceStorage.get(key) ?? null,
      outboxEntries: () => checkOutbox.getSnapshot().entries,
      outboxStored: () => [...outboxStorage.values()].map((value) => JSON.parse(value)),
      restart: async () => {
        setMount((current) => ({ key: current.key + 1, client: null }));
        await new Promise((resolve) => setTimeout(resolve, 50));
        await activateOutbox();
        setMount((current) => ({ key: current.key + 1, client: newClient() }));
      },
    };
    window.harnessReady = true;
  }, []);
  if (!mount.client) return null;
  return (
    <QueryClientProvider key={mount.key} client={mount.client}>
      <CleaningScreen />
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')).render(<Harness />);
