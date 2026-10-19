import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building } from "lucide-react";
import { useAuth } from "@/context/auth-context";
import { apiFetch, getApiErrorMessage } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * A Manager given several departments works in one at a time. The choice is
 * kept by the server for their session, so every page (and every list,
 * report and form on it) shows that department until they switch again.
 */
export function DepartmentSwitcher() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [switching, setSwitching] = useState(false);
  const ids = user?.role === "client_manager" && !user.allDepartments ? user.departmentIds ?? [] : [];
  const departments = useQuery<Array<{ id: number; name: string }>>({
    queryKey: ["departments", "switcher"],
    enabled: ids.length > 1,
    queryFn: async () => {
      const response = await apiFetch("/departments");
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not load departments"));
      return response.json();
    },
  });
  if (ids.length < 2) return null;
  const choices = ids.map(id => ({ id, name: departments.data?.find(d => d.id === id)?.name ?? "Department" }));

  async function choose(value: string) {
    setSwitching(true);
    const response = await apiFetch("/users/me/active-department", { method: "PUT", body: JSON.stringify({ departmentId: Number(value) }) });
    if (!response.ok) {
      setSwitching(false);
      toast({ title: "Department not changed", description: await getApiErrorMessage(response, "Please try again."), variant: "destructive" });
      return;
    }
    // Reload so every page and cached list is fetched for the new department.
    window.location.reload();
  }

  return (
    <Select value={user?.departmentId?.toString() ?? ""} onValueChange={choose} disabled={switching}>
      <SelectTrigger className="h-9 w-auto max-w-[11rem] gap-1.5 text-xs sm:text-sm" aria-label="Department you're working in" data-testid="department-switcher">
        <Building className="h-4 w-4 shrink-0 text-primary" />
        <SelectValue placeholder="Department" />
      </SelectTrigger>
      <SelectContent>
        {choices.map(choice => (
          <SelectItem key={choice.id} value={choice.id.toString()}>{choice.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
