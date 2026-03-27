import { AppLayout } from "@/components/layout";
import { Wrench } from "lucide-react";

export default function MaintenanceModulePage() {
  return (
    <AppLayout title="Maintenance">
      <div className="flex flex-col items-center justify-center h-64 gap-4 text-center">
        <div className="bg-blue-100 p-4 rounded-2xl">
          <Wrench className="w-10 h-10 text-blue-600" />
        </div>
        <div>
          <h2 className="text-lg font-semibold mb-1">Maintenance Module</h2>
          <p className="text-muted-foreground text-sm">This module is coming soon.</p>
        </div>
      </div>
    </AppLayout>
  );
}
