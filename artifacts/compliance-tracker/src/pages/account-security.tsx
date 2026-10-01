import { AppLayout } from "@/components/layout";
import { useAuth } from "@/context/auth-context";
import { TwoFactorCard } from "@/pages/settings";

export default function AccountSecurityPage() {
  const { user } = useAuth();

  return (
    <AppLayout title="Account Security">
      <div className="max-w-4xl">
        <TwoFactorCard key={user?.id ?? "signed-out"} />
      </div>
    </AppLayout>
  );
}