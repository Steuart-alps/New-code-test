import { AppLayout } from "@/components/layout";
import { DocumentLibrary } from "@/components/document-library";

export default function DocumentsPage() {
  return (
    <AppLayout title="Documents">
      <DocumentLibrary />
    </AppLayout>
  );
}
