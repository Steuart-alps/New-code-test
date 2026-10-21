import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { FileWarning } from "lucide-react";
import { Card } from "@/components/ui/card";
import { useAuth } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { formatDay } from "@/lib/onboarding";

interface CertificateOutstanding {
  itemId: number;
  title: string;
  siteId: number | null;
  siteName: string | null;
  visitDate: string;
  daysSinceVisit: number;
  contractorName: string;
  chasing: boolean;
}

interface CertificatesOutstanding {
  followUpAfterDays: number;
  chaseStopsAfterDays: number;
  certificates: CertificateOutstanding[];
}

/**
 * Contractor visits still waiting for their certificate, oldest first. The
 * contractor is chased every two weeks (through Contractor Approvals) until
 * chaseStopsAfterDays after the visit; after that it is up to the business.
 * Hidden when nothing is outstanding.
 */
export function CertificatesOutstandingCard() {
  const { activeClientId } = useAuth();
  const clientApiFetch = useActiveClientApi();

  const { data, isError } = useQuery<CertificatesOutstanding>({
    queryKey: ["certificates-outstanding", activeClientId],
    queryFn: async () => {
      const response = await clientApiFetch("/certificates-outstanding");
      if (!response.ok) throw new Error("Failed to load outstanding certificates");
      return response.json();
    },
    enabled: !!activeClientId,
  });
  const showSite = useMemo(
    () => new Set(data?.certificates.map(certificate => certificate.siteId)).size > 1,
    [data],
  );

  if (isError) return <p role="alert" className="text-destructive text-sm mb-8">Could not load outstanding certificates.</p>;
  if (!data || data.certificates.length === 0) return null;

  return (
    <Card className="p-5 mb-8 bg-card/60 border-border/50">
      <h2 className="font-display font-semibold text-lg flex items-center gap-2">
        <FileWarning aria-hidden="true" className="w-5 h-5 text-amber-600" /> Certificates outstanding ({data.certificates.length})
      </h2>
      <p className="text-sm text-muted-foreground mt-1 mb-4 max-w-2xl">
        The contractor has been but no certificate has been uploaded {data.followUpAfterDays} days on. Certificates are often held
        until the invoice is paid. The contractor is chased every two weeks through Contractor Approvals, for {data.chaseStopsAfterDays} days.
        Upload the certificate on the check when it arrives.
      </p>
      <ul className="divide-y divide-border/60 rounded-sm border border-border/60">
        {data.certificates.map(certificate => (
          <li key={`${certificate.itemId}-${certificate.visitDate}`} className="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="min-w-0">
              <Link href={`/items/${certificate.itemId}`} className="font-medium text-primary hover:underline">
                {certificate.title}
              </Link>
              <p className="text-sm text-muted-foreground">
                {showSite && certificate.siteName ? `${certificate.siteName} · ` : ""}
                Visited {formatDay(certificate.visitDate)} by {certificate.contractorName} · {certificate.daysSinceVisit} days ago
              </p>
            </div>
            {!certificate.chasing && (
              <span className="text-xs font-medium text-destructive sm:text-right sm:max-w-56">
                Reminders to the contractor have stopped: please chase them directly
              </span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
