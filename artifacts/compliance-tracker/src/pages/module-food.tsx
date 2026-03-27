import { AppLayout } from "@/components/layout";
import { UtensilsCrossed } from "lucide-react";

export default function FoodModulePage() {
  return (
    <AppLayout title="Food Safety">
      <div className="flex flex-col items-center justify-center h-64 gap-4 text-center">
        <div className="bg-green-100 p-4 rounded-2xl">
          <UtensilsCrossed className="w-10 h-10 text-green-600" />
        </div>
        <div>
          <h2 className="text-lg font-semibold mb-1">Food Safety Module</h2>
          <p className="text-muted-foreground text-sm">This module is coming soon.</p>
        </div>
      </div>
    </AppLayout>
  );
}
