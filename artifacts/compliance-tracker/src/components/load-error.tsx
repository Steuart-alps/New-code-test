import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Shown when records could not be loaded, so a failed request is never
 * mistaken for an empty record ("No checks recorded yet").
 */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
      <span className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {message} Check your connection and try again.
      </span>
      <Button type="button" variant="outline" size="sm" className="bg-white" onClick={onRetry}>
        <RotateCw className="mr-1.5 h-3.5 w-3.5" /> Retry
      </Button>
    </div>
  );
}
