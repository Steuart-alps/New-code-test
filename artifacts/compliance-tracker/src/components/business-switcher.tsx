import { useState } from "react";
import { Store } from "lucide-react";
import { useAuth } from "@/context/auth-context";
import { apiFetch, getApiErrorMessage } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { sortByLabel } from "@/lib/sort-options";

/**
 * An Owner of several businesses uses one login and works in one business at
 * a time. The choice is kept by the server for their session, so every page
 * shows that business until they switch again. Each business keeps its own
 * data, users and subscription.
 */
export function BusinessSwitcher() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [switching, setSwitching] = useState(false);
  const businesses = user?.role === "client_admin" ? user.businesses ?? [] : [];
  if (businesses.length < 2) return null;
  const choices = sortByLabel(businesses.map(b => ({ value: b.id.toString(), label: b.name })), b => b.label);

  async function choose(value: string) {
    if (value === user?.clientId?.toString()) return;
    setSwitching(true);
    const response = await apiFetch("/users/me/active-business", { method: "PUT", body: JSON.stringify({ businessId: Number(value) }) });
    if (!response.ok) {
      setSwitching(false);
      toast({ title: "Business not changed", description: await getApiErrorMessage(response, "Please try again."), variant: "destructive" });
      return;
    }
    // Start on the new business's dashboard, with every list fetched afresh.
    window.location.assign(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/dashboard`);
  }

  return (
    <Select value={user?.clientId?.toString() ?? ""} onValueChange={choose} disabled={switching}>
      <SelectTrigger className="h-9 w-auto max-w-[13rem] gap-1.5 text-xs sm:text-sm" aria-label="Business you're working in" data-testid="business-switcher">
        <Store className="h-4 w-4 shrink-0 text-primary" />
        <SelectValue placeholder="Business" />
      </SelectTrigger>
      <SelectContent>
        {choices.map(choice => (
          <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
