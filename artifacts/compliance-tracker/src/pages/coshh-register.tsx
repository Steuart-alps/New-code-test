import { Redirect } from "wouter";
import { FlaskConical, Info } from "lucide-react";
import { AppLayout } from "@/components/layout";
import { CoshhRegisterPanel } from "@/components/coshh-register-panel";
import { useAuth } from "@/context/auth-context";

// The free COSHH register. Businesses with COSHHTrack keep the same register
// as COSHHTrack's Substances tab, so this page sends them there rather than
// showing a second copy.
export default function CoshhRegisterPage() {
  const { services, hasService } = useAuth();
  if (services != null && hasService("coshhtrack")) return <Redirect to="/coshh-track?tab=substances" replace />;

  return (
    <AppLayout title="COSHH register">
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-sm bg-orange-50 border border-orange-200 flex items-center justify-center shrink-0">
            <FlaskConical className="w-4 h-4 text-orange-700" />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight">COSHH register</h1>
            <p className="text-xs text-muted-foreground">Hazardous substances used at each site, with safety data sheets and assessments</p>
          </div>
        </div>

        <div className="flex gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
          <Info className="w-4 h-4 shrink-0 mt-0.5" />
          <p>
            The Control of Substances Hazardous to Health Regulations 2002 expect you to assess the risks from
            hazardous substances, put controls in place and review the assessment regularly and whenever something
            changes. The suggested 12-month review is a common default, not a legal interval: set the date that fits
            your assessment.
          </p>
        </div>

        <CoshhRegisterPanel />
      </div>
    </AppLayout>
  );
}
