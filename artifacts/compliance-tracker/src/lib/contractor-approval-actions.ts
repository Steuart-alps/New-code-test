export interface ContractorApprovalItem {
  id: number;
  emailType: string;
}

export interface EditedContractorEmail {
  subject: string;
  text: string;
}

export interface ContractorApprovalActions {
  confirm: (message: string) => boolean;
  clientApiFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

export const CANCELLATION_APPROVAL_CONFIRMATION =
  "Approve this calendar cancellation? It will send the contractor a cancellation notice and remove the previously sent calendar event.";

export const CANCELLATION_DISMISS_CONFIRMATION =
  "Dismiss this calendar cancellation? Nothing will be sent and the existing calendar event will remain in place.";

export async function approveContractorEmail(
  item: ContractorApprovalItem,
  actions: ContractorApprovalActions,
  edited?: EditedContractorEmail,
) {
  const isCancellation = item.emailType === "cancellation";
  if (isCancellation && !actions.confirm(CANCELLATION_APPROVAL_CONFIRMATION)) {
    return { confirmed: false as const };
  }

  const endpoint = edited ? "edit-and-send" : "approve-and-send";
  const payload = edited ? { subject: edited.subject, bodyText: edited.text } : {};
  const response = await actions.clientApiFetch(
    `/fix-track/contractor-email-queue/${item.id}/${endpoint}`,
    { method: "POST", body: JSON.stringify(payload) },
  );
  if (!response.ok) throw new Error("Failed to approve email");
  return { confirmed: true as const, response };
}

export async function dismissContractorEmail(
  item: ContractorApprovalItem,
  actions: ContractorApprovalActions,
) {
  const isCancellation = item.emailType === "cancellation";
  const confirmation = isCancellation
    ? CANCELLATION_DISMISS_CONFIRMATION
    : "Are you sure you want to cancel this email request?";
  if (!actions.confirm(confirmation)) return { confirmed: false as const };

  const response = await actions.clientApiFetch(
    `/fix-track/contractor-email-queue/${item.id}/cancel`,
    { method: "POST" },
  );
  if (!response.ok) throw new Error("Failed to cancel email");
  return { confirmed: true as const, response };
}