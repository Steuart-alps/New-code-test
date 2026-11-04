import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "../src/context/auth-context";
import { useState } from "react";
import { CertificateReaderButton, CertificateReaderDialog } from "../src/components/certificate-reader-dialog";
import { installStrayFileDropGuard, useFileDrop } from "../src/hooks/use-file-drop";
import { Toaster } from "../src/components/ui/toaster";
import "../src/index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 } },
});

installStrayFileDropGuard();

// Like a check's Certificates box (pages/item-detail.tsx): a file dropped on
// it opens the reader with that file.
function CertificatesBox() {
  const [dropped, setDropped] = useState<File[] | null>(null);
  const drop = useFileDrop(setDropped, !dropped);
  return <>
    <section data-testid="certificates-box" className="border p-6" {...drop.dropZoneProps}>Certificates</section>
    {dropped && <CertificateReaderDialog open onOpenChange={(open) => { if (!open) setDropped(null); }} itemId={41} initialFiles={dropped} />}
  </>;
}

function Harness() {
  const { user, isLoading } = useAuth();
  if (isLoading || !user) return <p>Loading test account</p>;
  return <div className="p-4">
    <CertificateReaderButton />
    <CertificatesBox />
    <Toaster />
  </div>;
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <Harness />
    </AuthProvider>
  </QueryClientProvider>,
);
