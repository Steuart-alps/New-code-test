import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SetupServiceOffer, type SetupAssistRequest } from "@/components/setup-getting-started";
import { useAuth } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useToast } from "@/hooks/use-toast";
import { getApiErrorMessage } from "@/lib/api";

/**
 * The ALPS setup service ("ALPS Assist") offered outside the setup wizard,
 * on "Upload your lists": the same offer and request as the wizard's
 * getting-started page (POST /setup/assist-request). Owners only, like there.
 */
export function AlpsAssistOffer() {
  const { user, activeClientId } = useAuth();
  const clientApiFetch = useActiveClientApi();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isOwner = user?.role === "client_admin";
  const state = useQuery({
    queryKey: ["setup-assist-request", activeClientId],
    enabled: isOwner,
    queryFn: async () => {
      const response = await clientApiFetch("/setup/state");
      if (!response.ok) return null;
      const data = await response.json() as { assistRequest?: SetupAssistRequest | null };
      return data.assistRequest ?? null;
    },
  });
  if (!isOwner || state.isLoading || state.isError) return null;

  async function request(details: { phone: string; notes: string }) {
    const response = await clientApiFetch("/setup/assist-request", {
      method: "POST",
      body: JSON.stringify({ ...(details.phone ? { phone: details.phone } : {}), ...(details.notes ? { notes: details.notes } : {}) }),
    });
    if (!response.ok) {
      const message = await getApiErrorMessage(response, "Your request didn't reach ALPS. Please try again.");
      toast({ title: "Request not sent", description: message, variant: "destructive" });
      throw new Error(message);
    }
    const result = await response.json() as SetupAssistRequest;
    queryClient.setQueryData(["setup-assist-request", activeClientId], { requestedAt: result.requestedAt, requestedBy: result.requestedBy });
    toast({ title: "Request sent to ALPS", description: "We'll be in touch to arrange how to send your lists." });
  }

  return <SetupServiceOffer request={state.data ?? null} onRequest={request} />;
}
