import { Link } from "wouter";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { useRegisterList } from "@/components/register-shared";

interface AsbestosRow { id: number; siteId: number | null; planReviewOverdue: boolean }

/**
 * Dashboard tile for overdue asbestos management plan reviews (core
 * register). Uses the register list, which already applies the caller's
 * department scope and computes the overdue flag. Renders nothing when no
 * review is overdue. (COSHH reviews belong to COSHHTrack assessments.)
 */
export function RegisterReviewsDue({ siteId = null }: { siteId?: number | null }) {
  const { data: asbestos = [] } = useRegisterList<AsbestosRow>("/registers/asbestos");
  const inSite = (row: { siteId: number | null }) => siteId === null || row.siteId === siteId;
  const asbestosOverdue = asbestos.filter((row) => row.planReviewOverdue && inSite(row)).length;
  if (asbestosOverdue === 0) return null;

  const rows = [
    { count: asbestosOverdue, href: "/asbestos", label: `asbestos management plan review${asbestosOverdue === 1 ? "" : "s"} overdue` },
  ];

  return (
    <section aria-label="Register reviews overdue" className="rounded-xl border border-red-200 bg-red-50/50 px-4 py-3">
      <ul className="space-y-1.5">
        {rows.map((row) => (
          <li key={row.href}>
            <Link href={row.href} className="flex items-center gap-3 text-sm text-red-800 hover:underline">
              <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0" />
              <span className="font-semibold">{row.count} {row.label}</span>
              <ArrowRight className="w-3 h-3 ml-auto shrink-0" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
