import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout";
import { ContractorFormDialog } from "@/components/contractor-form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, Building, Mail, Phone, ChevronRight, CheckCircle2, AlertTriangle, Clock } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuth } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { getContractorListStatus, type ContractorListRecord, type ContractorListStatus } from "@/lib/contractor-list-status";

const statusStyle = {
  complete: { label: "Up to date", icon: CheckCircle2, color: "bg-emerald-50 border-emerald-200 text-emerald-800" },
  expiring: { label: "Expiring soon", icon: Clock, color: "bg-amber-50 border-amber-200 text-amber-900" },
  "missing-or-expired": { label: "Missing or expired", icon: AlertTriangle, color: "bg-rose-50 border-rose-200 text-rose-800" },
} as const;

function ComplianceIndicator({ status }: { status: ContractorListStatus }) {
  const { label, icon: Icon, color } = statusStyle[status.level];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} aria-label={`${label}. ${status.problems.join(". ") || "All tracked fields are current."}`} className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-xs font-semibold ${color}`}>
          <Icon aria-hidden="true" className="w-3.5 h-3.5" /> {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64 text-sm">
        {status.problems.length ? (
          <ul className="list-disc space-y-1 pl-4">{status.problems.map(problem => <li key={problem}>{problem}</li>)}</ul>
        ) : "Insurance, DBS / PVG and Gas Safe registration are current."
        }
      </TooltipContent>
    </Tooltip>
  );
}

export default function ContractorsPage() {
  const [search, setSearch] = useState("");
  const [showNonCompliantOnly, setShowNonCompliantOnly] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const { activeClientId } = useAuth();
  const clientApiFetch = useActiveClientApi();

  const { data: contractors = [], isLoading, isError } = useQuery<ContractorListRecord[]>({
    queryKey: ["contractors", activeClientId],
    queryFn: async () => {
      const response = await clientApiFetch("/contractors");
      if (!response.ok) throw new Error("Failed to load contractors");
      return response.json();
    },
    enabled: !!activeClientId,
  });

  const today = new Date();
  const filtered = contractors.filter(c => {
    const matchesSearch = c.name.toLowerCase().includes(search.toLowerCase()) ||
      Boolean(c.company?.toLowerCase().includes(search.toLowerCase()));
    return matchesSearch && (!showNonCompliantOnly || getContractorListStatus(c, today).level === "missing-or-expired");
  });
  const nonCompliantCount = contractors.filter(c => getContractorListStatus(c, today).level === "missing-or-expired").length;

  return (
    <AppLayout title="Contractors">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
        <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto">
          <div className="relative w-full sm:w-80">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search contractors..."
              className="pl-9 bg-card shadow-sm"
            />
          </div>
          <Button
            type="button"
            variant={showNonCompliantOnly ? "default" : "outline"}
            aria-pressed={showNonCompliantOnly}
            onClick={() => setShowNonCompliantOnly(value => !value)}
          >
            <AlertTriangle className="w-4 h-4 mr-2" />
            Missing or expired ({nonCompliantCount})
          </Button>
        </div>
        <Button onClick={() => setIsFormOpen(true)} className="shadow-lg shadow-primary/20 w-full sm:w-auto">
          <Plus className="w-4 h-4 mr-2" /> Add Contractor
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>
      ) : isError ? (
        <p role="alert" className="text-destructive py-12 text-center">Could not load contractors. Please try again.</p>
      ) : filtered.length === 0 ? (
        <div className="text-center py-24 bg-card rounded-2xl border border-dashed border-border/60">
          <Building className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
          <h3 className="text-lg font-semibold">No contractors found</h3>
          <p className="text-muted-foreground mt-1 max-w-sm mx-auto">
            {showNonCompliantOnly ? "No contractors with missing or expired compliance fields match your search." : search ? "Try another search." : "Add your external contractors here to track their compliance and certificates."}
          </p>
        </div>
      ) : (
        <TooltipProvider>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map(contractor => (
              <Link key={contractor.id} href={`/contractors/${contractor.id}`}>
                <Card className="p-5 hover:shadow-xl hover:border-primary/30 transition-all duration-300 cursor-pointer group bg-card/60 backdrop-blur-sm border-border/50 h-full flex flex-col">
                  <div className="flex justify-between items-start mb-4">
                    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-lg">
                      {contractor.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex items-center gap-2">
                      <ComplianceIndicator status={getContractorListStatus(contractor, today)} />
                      <ChevronRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors transform group-hover:translate-x-1" />
                    </div>
                  </div>
                  <h3 className="font-display font-semibold text-lg">{contractor.name}</h3>
                  {contractor.company && <p className="text-sm text-muted-foreground mt-0.5">{contractor.company}</p>}

                  <div className="mt-auto pt-5 space-y-2">
                    <div className="flex items-center text-sm text-muted-foreground">
                      <Mail className="w-4 h-4 mr-2 opacity-70" /> {contractor.email}
                    </div>
                    {contractor.phone && (
                      <div className="flex items-center text-sm text-muted-foreground">
                        <Phone className="w-4 h-4 mr-2 opacity-70" /> {contractor.phone}
                      </div>
                    )}
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </TooltipProvider>
      )}

      <ContractorFormDialog 
        isOpen={isFormOpen} 
        onClose={() => setIsFormOpen(false)} 
      />
    </AppLayout>
  );
}
