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

/** The API's code for an action on a draft that is no longer pending. */
export const QUEUE_ENTRY_NOT_PENDING = "queue_entry_not_pending";

/** Another manager or tab already approved, sent or dismissed the request, so
 *  this action changed nothing. */
export class ApprovalAlreadyHandledError extends Error {
  constructor(readonly action: "approve" | "dismiss") {
    super(
      action === "approve"
        ? "This request was already handled, so nothing was sent."
        : "This request was already handled, so nothing was dismissed.",
    );
    this.name = "ApprovalAlreadyHandledError";
  }
}

/** The API's codes for a contractor portal reminder whose portal link was
 *  reissued, revoked or expired after approval: nothing was sent. */
export const PORTAL_LINK_CHANGED_CODES = ["portal_link_reissued", "portal_link_revoked", "portal_link_invalid"] as const;

/** A manager changed the contractor's portal link before this reminder was
 *  sent, so nothing was sent. The message is the server's explanation. */
export class ApprovalPortalLinkChangedError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "ApprovalPortalLinkChangedError";
  }
}

async function conflictBody(response: Response): Promise<{ code?: unknown; error?: unknown } | null> {
  if (response.status !== 409 || typeof response.json !== "function") return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function isAlreadyHandled(response: Response) {
  return (await conflictBody(response))?.code === QUEUE_ENTRY_NOT_PENDING;
}

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
  if (!response.ok) {
    const conflict = await conflictBody(response);
    if (conflict?.code === QUEUE_ENTRY_NOT_PENDING) throw new ApprovalAlreadyHandledError("approve");
    if ((PORTAL_LINK_CHANGED_CODES as readonly unknown[]).includes(conflict?.code)) {
      throw new ApprovalPortalLinkChangedError(
        typeof conflict?.error === "string" ? conflict.error : "The contractor's portal link changed, so nothing was sent.",
        String(conflict?.code),
      );
    }
    throw new Error("Failed to approve email");
  }
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
  if (!response.ok) {
    if (await isAlreadyHandled(response)) throw new ApprovalAlreadyHandledError("dismiss");
    throw new Error("Failed to cancel email");
  }
  return { confirmed: true as const, response };
}