import { AppLayout } from "@/components/layout";
import { Flame } from "lucide-react";

export default function FireModulePage() {
  return (
    <AppLayout title="Fire Safety">
      <div className="flex flex-col items-center justify-center h-64 gap-4 text-center">
        <div className="bg-orange-100 p-4 rounded-2xl">
          <Flame className="w-10 h-10 text-orange-500" />
        </div>
        <div>
          <h2 className="text-lg font-semibold mb-1">Fire Safety Module</h2>
          <p className="text-muted-foreground text-sm">This module is coming soon.</p>
        </div>
      </div>
    </AppLayout>
  );
}
