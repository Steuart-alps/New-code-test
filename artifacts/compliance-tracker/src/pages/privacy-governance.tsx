import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { AlertTriangle, BadgeCheck, Clock3, FileText, Plus, Shield, ShieldAlert } from "lucide-react";
import {
  useAddPrivacyRetentionVerification,
  useCreatePrivacyRecord,
  useGetPrivacyGovernance,
  useSavePrivacyProgram,
  useUpdatePrivacyRecord,
} from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/context/auth-context";
import { useToast } from "@/hooks/use-toast";

type RecordKind = "activity" | "rights_request" | "retention" | "processor" | "breach";
type RecordItem = { id: number; kind: RecordKind; [key: string]: any };
type PrivacyProgram = { id: number; [key: string]: any };
type GovernanceData = {
  program: PrivacyProgram | null;
  activities: RecordItem[];
  rightsRequests: RecordItem[];
  retentionSchedules: RecordItem[];
  retentionVerifications: Array<Record<string, any>>;
  processors: RecordItem[];
  breaches: RecordItem[];
};

type FieldKind = "text" | "textarea" | "select" | "datetime" | "number" | "checkbox" | "nullableBoolean";
type FieldOption = { value: string; label: string };
type FieldConfig = {
  name: string;
  label: string;
  type: FieldKind;
  required?: boolean;
  nullable?: boolean;
  hint?: string;
  options?: FieldOption[];
};

const requestTypes: FieldOption[] = [
  { value: "access", label: "Access" },
  { value: "rectification", label: "Rectification" },
  { value: "erasure", label: "Erasure" },
  { value: "restriction", label: "Restriction" },
  { value: "portability", label: "Portability" },
  { value: "objection", label: "Objection" },
  { value: "other", label: "Other" },
];

const recordFields: Record<RecordKind, FieldConfig[]> = {
  activity: [
    { name: "name", label: "Activity name", type: "text", required: true },
    { name: "purpose", label: "Purpose", type: "textarea", required: true },
    { name: "dataSubjects", label: "People whose data is used", type: "textarea", required: true },
    { name: "dataCategories", label: "Personal data categories", type: "textarea", required: true },
    { name: "article6Basis", label: "Article 6 lawful-basis classification", type: "select", required: true, options: [
      { value: "consent", label: "Consent" }, { value: "contract", label: "Contract" },
      { value: "legal_obligation", label: "Legal obligation" }, { value: "vital_interests", label: "Vital interests" },
      { value: "public_task", label: "Public task" }, { value: "legitimate_interests", label: "Legitimate interests" },
      { value: "other", label: "Other / record locally" },
    ] },
    { name: "article6Rationale", label: "Basis assessment notes", type: "textarea", nullable: true },
    { name: "specialCategoryData", label: "Special-category data is involved", type: "checkbox", hint: "If selected, record the Article 9 condition and your rationale." },
    { name: "article9Condition", label: "Article 9 condition (if applicable)", type: "textarea", nullable: true },
    { name: "article9Rationale", label: "Article 9 assessment notes", type: "textarea", nullable: true },
    { name: "recipients", label: "Recipients or recipient categories", type: "textarea", nullable: true },
    { name: "transferDetails", label: "International transfers or locations", type: "textarea", nullable: true },
    { name: "retentionCriteria", label: "Retention criteria", type: "textarea", required: true, hint: "Record your chosen criteria; this is not a universal retention period." },
    { name: "securityMeasures", label: "Security measures", type: "textarea", nullable: true },
    { name: "dpiaClassification", label: "DPIA screening / assessment status", type: "select", required: true, options: [
      { value: "not_screened", label: "Not screened" }, { value: "not_required", label: "Screened — not required" },
      { value: "required", label: "Required" }, { value: "in_progress", label: "In progress" }, { value: "completed", label: "Completed" },
    ] },
    { name: "dpiaRationale", label: "DPIA decision or assessment notes", type: "textarea", nullable: true },
    { name: "dpiaCompletedAt", label: "DPIA completed at", type: "datetime", nullable: true },
    { name: "owner", label: "Record owner", type: "text", nullable: true },
    { name: "reviewDueAt", label: "Next review date", type: "datetime", nullable: true },
    { name: "active", label: "Activity is current", type: "checkbox" },
  ],
  rights_request: [
    { name: "requestType", label: "Request type", type: "select", required: true, options: requestTypes },
    { name: "subjectName", label: "Requester name", type: "text", required: true },
    { name: "subjectContact", label: "Requester contact", type: "text", nullable: true },
    { name: "scopeDescription", label: "Request scope and received channel", type: "textarea", required: true },
    { name: "receivedAt", label: "Received at", type: "datetime", required: true },
    { name: "extendedDueAt", label: "Extended deadline (if used)", type: "datetime", nullable: true, hint: "Initial deadline is calculated as one calendar month after receipt." },
    { name: "extensionReason", label: "Extension reason", type: "textarea", nullable: true },
    { name: "identityStatus", label: "Identity verification", type: "select", required: true, options: [
      { value: "not_started", label: "Not started" }, { value: "in_progress", label: "In progress" },
      { value: "verified", label: "Verified" }, { value: "failed", label: "Failed" },
    ] },
    { name: "identityMethod", label: "Verification method", type: "text", nullable: true },
    { name: "identityEvidence", label: "Verification evidence reference", type: "textarea", nullable: true, hint: "Record a reference only. Do not upload identity documents here." },
    { name: "status", label: "Request status", type: "select", required: true, options: [
      { value: "received", label: "Received" }, { value: "in_progress", label: "In progress" },
      { value: "waiting_for_information", label: "Waiting for information" }, { value: "completed", label: "Completed" },
      { value: "refused", label: "Refused" }, { value: "withdrawn", label: "Withdrawn" },
    ] },
    { name: "decision", label: "Decision", type: "select", nullable: true, options: [
      { value: "granted", label: "Granted" }, { value: "partially_granted", label: "Partially granted" },
      { value: "refused", label: "Refused" }, { value: "not_applicable", label: "Not applicable" },
    ] },
    { name: "decisionRationale", label: "Decision rationale", type: "textarea", nullable: true },
    { name: "responseSentAt", label: "Response sent at", type: "datetime", nullable: true },
    { name: "responseEvidence", label: "Response / delivery evidence", type: "textarea", nullable: true },
  ],
  retention: [
    { name: "recordCategory", label: "Record category", type: "text", required: true },
    { name: "scopeDescription", label: "Data and systems in scope", type: "textarea", required: true },
    { name: "retentionPeriod", label: "Retention period or criteria", type: "text", required: true, hint: "Set this for your purpose and context; no fixed period is assumed." },
    { name: "retentionTrigger", label: "Retention trigger", type: "text", required: true },
    { name: "justification", label: "Reason for keeping or deleting", type: "textarea", required: true },
    { name: "legalHoldActive", label: "Legal hold active", type: "checkbox" },
    { name: "legalHoldReason", label: "Legal hold reason", type: "textarea", nullable: true },
    { name: "deletionException", label: "Deletion exception active", type: "checkbox" },
    { name: "deletionExceptionReason", label: "Deletion exception reason", type: "textarea", nullable: true },
    { name: "reviewDueAt", label: "Next schedule review", type: "datetime", nullable: true },
    { name: "active", label: "Schedule is current", type: "checkbox" },
  ],
  processor: [
    { name: "organizationName", label: "Provider / organization", type: "text", required: true },
    { name: "role", label: "Role", type: "select", required: true, options: [
      { value: "processor", label: "Processor" }, { value: "subprocessor", label: "Subprocessor" },
    ] },
    { name: "parentProcessor", label: "Appointing processor (if subprocessor)", type: "text", nullable: true },
    { name: "serviceDescription", label: "Service and processing purpose", type: "textarea", required: true },
    { name: "dataCategories", label: "Data categories", type: "textarea", required: true },
    { name: "processingCountries", label: "Processing / storage countries", type: "text", required: true },
    { name: "transferMechanism", label: "Transfer mechanism assessment", type: "select", required: true, options: [
      { value: "not_assessed", label: "Not assessed" }, { value: "no_restricted_transfer", label: "No restricted transfer identified" },
      { value: "adequacy", label: "Adequacy decision" }, { value: "uk_idta", label: "UK IDTA" },
      { value: "eu_scc", label: "EU SCCs" }, { value: "uk_addendum", label: "UK Addendum" }, { value: "other", label: "Other" },
    ] },
    { name: "transferSafeguards", label: "Safeguards / transfer details", type: "textarea", nullable: true },
    { name: "transferAssessment", label: "Transfer assessment notes", type: "textarea", nullable: true },
    { name: "agreementStatus", label: "Processing agreement status", type: "select", required: true, options: [
      { value: "not_assessed", label: "Not assessed" }, { value: "in_place", label: "In place" },
      { value: "pending", label: "Pending" }, { value: "not_required", label: "Not required" },
    ] },
    { name: "agreementReviewedAt", label: "Agreement reviewed at", type: "datetime", nullable: true },
    { name: "transferReviewedAt", label: "Transfer review date", type: "datetime", nullable: true },
    { name: "reviewDueAt", label: "Next review date", type: "datetime", nullable: true },
    { name: "active", label: "Provider is current", type: "checkbox" },
  ],
  breach: [
    { name: "discoveredAt", label: "Discovered / awareness time", type: "datetime", required: true },
    { name: "occurredFrom", label: "Known start (if known)", type: "datetime", nullable: true },
    { name: "occurredTo", label: "Known end (if known)", type: "datetime", nullable: true },
    { name: "description", label: "Incident description", type: "textarea", required: true },
    { name: "dataCategories", label: "Personal data and systems affected", type: "textarea", required: true },
    { name: "affectedSubjectsEstimate", label: "Estimated people affected", type: "number", nullable: true },
    { name: "affectedRecordsEstimate", label: "Estimated records affected", type: "number", nullable: true },
    { name: "riskLevel", label: "Risk assessment", type: "select", required: true, options: [
      { value: "under_assessment", label: "Under assessment" }, { value: "unlikely", label: "Unlikely to create risk" },
      { value: "risk", label: "Risk identified" }, { value: "high_risk", label: "High risk identified" },
    ] },
    { name: "assessmentStatus", label: "Incident status", type: "select", required: true, options: [
      { value: "assessing", label: "Assessing" }, { value: "contained", label: "Contained" }, { value: "closed", label: "Closed" },
    ] },
    { name: "assessmentRationale", label: "Assessment and notification decision notes", type: "textarea", nullable: true },
    { name: "containmentSteps", label: "Containment and mitigation", type: "textarea", nullable: true },
    { name: "authorityNotificationRequired", label: "Supervisory authority notification decision", type: "nullableBoolean", nullable: true },
    { name: "authorityNotifiedAt", label: "Authority notified at", type: "datetime", nullable: true },
    { name: "authorityNotificationReference", label: "Authority notification reference", type: "text", nullable: true },
    { name: "individualNotificationRequired", label: "Individual notification decision", type: "nullableBoolean", nullable: true },
    { name: "individualNotificationDueAt", label: "Individual notification target", type: "datetime", nullable: true },
    { name: "individualsNotifiedAt", label: "Individuals notified at", type: "datetime", nullable: true },
    { name: "evidence", label: "Evidence / response record", type: "textarea", nullable: true },
  ],
};

const profileFields: FieldConfig[] = [
  { name: "customerRole", label: "Your recorded role for customer data", type: "select", required: true, options: [
    { value: "controller", label: "Controller" }, { value: "joint_controller", label: "Joint controller" },
    { value: "processor", label: "Processor" }, { value: "mixed", label: "Different roles by activity" },
  ] },
  { name: "controllerName", label: "Controller / organisation name", type: "text", nullable: true },
  { name: "controllerContact", label: "Privacy contact", type: "text", nullable: true },
  { name: "dpoContact", label: "DPO contact (if appointed)", type: "text", nullable: true },
  { name: "noticeUrl", label: "Privacy notice URL", type: "text", nullable: true },
  { name: "noticeVersion", label: "Notice version or publication date", type: "text", nullable: true },
  { name: "noticeReviewedAt", label: "Notice reviewed at", type: "datetime", nullable: true },
  { name: "processorAgreementStatus", label: "Processor agreement status", type: "select", required: true, options: [
    { value: "not_assessed", label: "Not assessed" }, { value: "in_place", label: "In place" },
    { value: "pending", label: "Pending" }, { value: "not_required", label: "Not required" },
  ] },
  { name: "processorAgreementReviewedAt", label: "Agreement review date", type: "datetime", nullable: true },
  { name: "responsibilitiesNotes", label: "Controller / processor responsibilities", type: "textarea", nullable: true },
  { name: "privacyOwner", label: "Internal privacy owner", type: "text", nullable: true },
];

function emptyRecord(kind: RecordKind): Record<string, any> {
  const common: Record<string, any> = Object.fromEntries(recordFields[kind].map((field) => [field.name, field.type === "checkbox" ? false : ""]));
  const defaults: Record<RecordKind, Record<string, any>> = {
    activity: { article6Basis: "contract", specialCategoryData: false, dpiaClassification: "not_screened", active: true },
    rights_request: { requestType: "access", receivedAt: new Date().toISOString(), identityStatus: "not_started", status: "received", decision: "" },
    retention: { legalHoldActive: false, deletionException: false, active: true },
    processor: { role: "processor", transferMechanism: "not_assessed", agreementStatus: "not_assessed", active: true },
    breach: { discoveredAt: new Date().toISOString(), riskLevel: "under_assessment", assessmentStatus: "assessing", authorityNotificationRequired: "", individualNotificationRequired: "" },
  };
  return { ...common, ...defaults[kind], kind };
}

function toLocalDateTime(value: unknown): string {
  if (!value) return "";
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function inputValue(value: unknown, field: FieldConfig): unknown {
  if (field.type === "datetime") return toLocalDateTime(value);
  if (field.type === "nullableBoolean") return value === true ? "true" : value === false ? "false" : "";
  if (field.type === "checkbox") return Boolean(value);
  if (value === null || value === undefined) return "";
  return value;
}

function serializeForm(values: Record<string, any>, fields: FieldConfig[]) {
  const result: Record<string, any> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (field.type === "datetime") result[field.name] = value ? new Date(value).toISOString() : null;
    else if (field.type === "number") result[field.name] = value === "" || value === null ? null : Number(value);
    else if (field.type === "nullableBoolean") result[field.name] = value === "" ? null : value === "true";
    else if (field.type === "checkbox") result[field.name] = Boolean(value);
    else if (field.nullable && value === "") result[field.name] = null;
    else result[field.name] = typeof value === "string" ? value.trim() : value;
  }
  return result;
}

function FieldControl({ field, register, setValue, value }: {
  field: FieldConfig;
  register: (name: any, options?: any) => any;
  setValue: (name: any, value: any, options?: any) => void;
  value: any;
}) {
  if (field.type === "checkbox") {
    return (
      <label className="flex items-start gap-3 rounded-lg border p-3">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" {...register(field.name)} />
        <span className="text-sm font-medium">{field.label}</span>
      </label>
    );
  }
  if (field.type === "select" || field.type === "nullableBoolean") {
    const options = field.type === "nullableBoolean"
      ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }]
      : field.options ?? [];
    return (
      <Select value={value ?? ""} onValueChange={(next) => setValue(field.name, next === "__unset" ? "" : next, { shouldDirty: true })}>
        <SelectTrigger id={field.name}><SelectValue placeholder={field.nullable ? "Not recorded" : "Choose"} /></SelectTrigger>
        <SelectContent>
          {field.nullable && <SelectItem value="__unset">Not recorded</SelectItem>}
          {options.map((option) => <SelectItem value={option.value} key={option.value}>{option.label}</SelectItem>)}
        </SelectContent>
      </Select>
    );
  }
  if (field.type === "textarea") {
    return <Textarea id={field.name} rows={3} maxLength={10_000} required={field.required} {...register(field.name)} />;
  }
  return (
    <Input
      id={field.name}
      type={field.type === "datetime" ? "datetime-local" : field.type}
      min={field.type === "number" ? "0" : undefined}
      maxLength={field.type === "text" ? 10_000 : undefined}
      required={field.required}
      {...register(field.name)}
    />
  );
}

function RecordEditor({ kind, record, saving, onCancel, onSave }: {
  kind: RecordKind;
  record?: RecordItem;
  saving: boolean;
  onCancel: () => void;
  onSave: (payload: Record<string, any>) => Promise<void>;
}) {
  const fields = recordFields[kind];
  const defaults = record ? { ...emptyRecord(kind), ...record } : emptyRecord(kind);
  const form = useForm<Record<string, any>>({
    defaultValues: Object.fromEntries(fields.map((field) => [field.name, inputValue(defaults[field.name], field)])),
  });

  return (
    <Card className="border-primary/30">
      <CardHeader>
        <CardTitle className="text-lg">{record ? "Update record" : "Add record"}</CardTitle>
        <CardDescription>Keep decisions and evidence concise. Do not attach identity documents or unnecessary personal data.</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((values) => onSave({ kind, ...serializeForm(values, fields) }))} className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              {fields.map((field) => (
                <div key={field.name} className={`space-y-2 ${field.type === "textarea" ? "md:col-span-2" : ""}`}>
                  {field.type !== "checkbox" && <Label htmlFor={field.name}>{field.label}{field.required ? " *" : ""}</Label>}
                  <FieldControl field={field} register={form.register} setValue={form.setValue} value={form.watch(field.name)} />
                  {field.hint && <p className="text-xs text-muted-foreground">{field.hint}</p>}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
              <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? "Saving…" : record ? "Save changes" : "Add record"}</Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

function ProgramEditor({ program, saving, onSave }: {
  program: PrivacyProgram | null;
  saving: boolean;
  onSave: (payload: Record<string, any>) => Promise<void>;
}) {
  const fields = profileFields;
  const defaults: Record<string, any> = {
    customerRole: "controller",
    processorAgreementStatus: "not_assessed",
    ...(program ?? {}),
  };
  const form = useForm<Record<string, any>>({
    defaultValues: Object.fromEntries(fields.map((field) => [field.name, inputValue(defaults[field.name], field)])),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Responsibilities and privacy notice</CardTitle>
        <CardDescription>Record your organisation's current view and review dates. Confirm role boundaries for each activity with your own adviser where needed.</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((values) => onSave(serializeForm(values, fields)))} className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              {fields.map((field) => (
                <div key={field.name} className={`space-y-2 ${field.type === "textarea" ? "md:col-span-2" : ""}`}>
                  <Label htmlFor={`program-${field.name}`}>{field.label}</Label>
                  {field.type === "select"
                    ? <Select value={form.watch(field.name) ?? ""} onValueChange={(value) => form.setValue(field.name, value, { shouldDirty: true })}>
                        <SelectTrigger id={`program-${field.name}`}><SelectValue /></SelectTrigger>
                        <SelectContent>{field.options?.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                      </Select>
                    : field.type === "textarea"
                      ? <Textarea id={`program-${field.name}`} rows={4} {...form.register(field.name)} />
                      : <Input id={`program-${field.name}`} type={field.type === "datetime" ? "datetime-local" : field.name === "noticeUrl" ? "url" : "text"} {...form.register(field.name)} />}
                </div>
              ))}
            </div>
            <div className="flex justify-end border-t pt-4">
              <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save privacy profile"}</Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

function VerificationEditor({ schedule, saving, onCancel, onSave }: {
  schedule: RecordItem;
  saving: boolean;
  onCancel: () => void;
  onSave: (payload: Record<string, string>) => Promise<void>;
}) {
  const form = useForm({ defaultValues: { outcome: "deletion_verified", recordsReviewed: "", verificationMethod: "", evidence: "" } });
  return (
    <Card className="border-primary/30">
      <CardHeader><CardTitle className="text-base">Record verification — {schedule.recordCategory}</CardTitle></CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSave)} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Outcome</Label>
                <Select value={form.watch("outcome")} onValueChange={(value) => form.setValue("outcome", value as any)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="deletion_verified">Deletion verified</SelectItem>
                    <SelectItem value="legal_hold_confirmed">Legal hold confirmed</SelectItem>
                    <SelectItem value="exception_confirmed">Deletion exception confirmed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2"><Label>Records reviewed</Label><Input required {...form.register("recordsReviewed")} /></div>
              <div className="space-y-2"><Label>Verification method</Label><Input required {...form.register("verificationMethod")} /></div>
              <div className="space-y-2 md:col-span-2"><Label>Evidence reference / result</Label><Textarea rows={3} required {...form.register("evidence")} /></div>
            </div>
            {schedule.legalHoldActive && <p className="text-sm text-amber-700">A legal hold is active. Deletion cannot be verified until the hold is released.</p>}
            {schedule.deletionException && <p className="text-sm text-amber-700">A deletion exception is active. Record that exception, not a completed deletion.</p>}
            <div className="flex justify-end gap-2 border-t pt-4">
              <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Record verification"}</Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

function formatDate(value: unknown): string {
  if (!value) return "Not recorded";
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) return "Not recorded";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function deadlineLabel(value: unknown): { label: string; overdue: boolean } | null {
  if (!value) return null;
  const remaining = new Date(String(value)).getTime() - Date.now();
  if (!Number.isFinite(remaining)) return null;
  if (remaining < 0) return { label: `Overdue by ${Math.ceil(Math.abs(remaining) / 86_400_000)} day(s)`, overdue: true };
  const days = Math.ceil(remaining / 86_400_000);
  return { label: days === 0 ? "Due today" : `Due in ${days} day(s)`, overdue: false };
}

function badgeClass(overdue: boolean) {
  return overdue
    ? "border-red-200 bg-red-50 text-red-700"
    : "border-amber-200 bg-amber-50 text-amber-800";
}

function RecordCard({ item, verificationCount, latestVerification, onEdit, onVerify }: {
  item: RecordItem;
  verificationCount?: number;
  latestVerification?: Record<string, any>;
  onEdit: (record: RecordItem) => void;
  onVerify?: (record: RecordItem) => void;
}) {
  const title = item.kind === "activity" ? item.name
    : item.kind === "rights_request" ? `${item.subjectName} · ${item.requestType}`
      : item.kind === "retention" ? item.recordCategory
        : item.kind === "processor" ? item.organizationName
          : `Breach assessment · ${formatDate(item.discoveredAt)}`;
  const details: Array<[string, unknown]> = item.kind === "activity" ? [
    ["Purpose", item.purpose], ["Article 6", item.article6Basis?.replaceAll("_", " ")],
    ["Article 9", item.specialCategoryData ? item.article9Condition ?? "Condition not recorded" : "No special-category data recorded"],
    ["DPIA", item.dpiaClassification?.replaceAll("_", " ")],
    ["Review due", item.reviewDueAt ? formatDate(item.reviewDueAt) : "Not set"],
  ] : item.kind === "rights_request" ? [
    ["Status", item.status?.replaceAll("_", " ")], ["Identity", item.identityStatus?.replaceAll("_", " ")],
    ["Decision", item.decision?.replaceAll("_", " ") ?? "Not decided"],
    ["Initial deadline", formatDate(item.dueAt)],
    ["Response deadline", formatDate(item.extendedDueAt ?? item.dueAt)],
  ] : item.kind === "retention" ? [
    ["Period / criteria", item.retentionPeriod], ["Trigger", item.retentionTrigger],
    ["Legal hold", item.legalHoldActive ? `Active — ${item.legalHoldReason}` : "None recorded"],
    ["Deletion exception", item.deletionException ? `Active — ${item.deletionExceptionReason}` : "None recorded"],
    ["Verification records", verificationCount ?? 0],
    ["Latest verification", latestVerification ? `${latestVerification.outcome?.replaceAll("_", " ")} · ${formatDate(latestVerification.verifiedAt)}` : "None recorded"],
  ] : item.kind === "processor" ? [
    ["Role", item.role], ["Service", item.serviceDescription], ["Countries", item.processingCountries],
    ["Transfer mechanism", item.transferMechanism?.replaceAll("_", " ")],
    ["Agreement", item.agreementStatus?.replaceAll("_", " ")],
    ["Review due", item.reviewDueAt ? formatDate(item.reviewDueAt) : "Not set"],
  ] : [
    ["Risk", item.riskLevel?.replaceAll("_", " ")], ["Status", item.assessmentStatus],
    ["Authority decision", item.authorityNotificationRequired === null ? "Not assessed" : item.authorityNotificationRequired ? "Notification recorded as required" : "Notification recorded as not required"],
    ["Individuals decision", item.individualNotificationRequired === null ? "Not assessed" : item.individualNotificationRequired ? "Notification recorded as required" : "Notification recorded as not required"],
    ["72-hour assessment timer", formatDate(item.authorityNotificationDueAt)],
  ];
  const timer = item.kind === "rights_request" && !["completed", "refused", "withdrawn"].includes(item.status)
    ? deadlineLabel(item.extendedDueAt ?? item.dueAt)
    : item.kind === "breach" && item.assessmentStatus !== "closed" && item.authorityNotifiedAt == null
      ? deadlineLabel(item.authorityNotificationDueAt)
      : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription className="mt-1">
              {item.kind === "rights_request" ? `Request #${String(item.id).padStart(6, "0")}` : item.kind === "breach" ? `Incident #${String(item.id).padStart(6, "0")}` : item.active === false ? "Archived from current records" : "Current record"}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {timer && <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${badgeClass(timer.overdue)}`}><Clock3 className="h-3.5 w-3.5" />{timer.label}</span>}
            {item.kind === "retention" && onVerify && <Button size="sm" variant="outline" onClick={() => onVerify(item)}>Record verification</Button>}
            <Button size="sm" variant="outline" onClick={() => onEdit(item)}>Edit</Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          {details.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
              <dd className="mt-1 whitespace-pre-wrap break-words text-sm">{value === null || value === undefined || value === "" ? "Not recorded" : String(value)}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function RecordSection({ title, description, kind, items, saving, verifications, onAdd, onEdit, onVerify, onSave, editor, onCancel }: {
  title: string;
  description: string;
  kind: RecordKind;
  items: RecordItem[];
  saving: boolean;
  verifications: Array<Record<string, any>>;
  onAdd: () => void;
  onEdit: (record: RecordItem) => void;
  onVerify: (record: RecordItem) => void;
  onSave: (payload: Record<string, any>) => Promise<void>;
  editor: { kind: RecordKind; record?: RecordItem } | null;
  onCancel: () => void;
}) {
  const rows = items.filter((item) => item.active !== false || kind === "rights_request" || kind === "breach");
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div><h2 className="text-xl font-semibold">{title}</h2><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>
        <Button onClick={onAdd}><Plus className="mr-2 h-4 w-4" />Add record</Button>
      </div>
      {editor?.kind === kind && <RecordEditor key={`${kind}-${editor.record?.id ?? "new"}`} kind={kind} record={editor.record} saving={saving} onCancel={onCancel} onSave={onSave} />}
      {rows.length === 0 && !editor && (
        <Card><CardContent className="py-10 text-center">
          <FileText className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <p className="font-medium">No records yet</p>
          <p className="mt-1 text-sm text-muted-foreground">Add a record when you have reviewed the relevant activity.</p>
        </CardContent></Card>
      )}
      <div className="space-y-3">
        {rows.map((item) => {
          const matching = kind === "retention" ? verifications.filter((verification) => verification.scheduleId === item.id) : [];
          const latest = matching[0];
          return <RecordCard
            key={`${kind}-${item.id}`}
            item={item}
            verificationCount={matching.length}
            latestVerification={latest}
            onEdit={onEdit}
            onVerify={kind === "retention" ? onVerify : undefined}
          />;
        })}
      </div>
    </div>
  );
}

export default function PrivacyGovernancePage() {
  const { activeClientId } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<{ kind: RecordKind; record?: RecordItem } | null>(null);
  const [verificationSchedule, setVerificationSchedule] = useState<RecordItem | null>(null);
  const clientParams = activeClientId === null ? undefined : { clientId: Number(activeClientId) };
  const query = useGetPrivacyGovernance(clientParams, {
    query: {
      queryKey: ["privacy-governance", activeClientId],
      enabled: activeClientId !== null,
      retry: false,
    },
  });
  const saveProgramMutation = useSavePrivacyProgram();
  const createRecordMutation = useCreatePrivacyRecord();
  const updateRecordMutation = useUpdatePrivacyRecord();
  const verificationMutation = useAddPrivacyRetentionVerification();
  const saving = saveProgramMutation.isPending || createRecordMutation.isPending || updateRecordMutation.isPending || verificationMutation.isPending;
  const data = query.data as unknown as GovernanceData | undefined;

  const activeRequests = useMemo(
    () => (data?.rightsRequests ?? []).filter((record) => !["completed", "refused", "withdrawn"].includes(record.status)),
    [data?.rightsRequests],
  );
  const overdueRequests = activeRequests.filter((record) => {
    const due = Date.parse(record.extendedDueAt ?? record.dueAt);
    return Number.isFinite(due) && due < Date.now();
  });
  const activeHolds = (data?.retentionSchedules ?? []).filter((record) => record.active && (record.legalHoldActive || record.deletionException));
  const activeBreachTimers = (data?.breaches ?? []).filter((record) =>
    record.assessmentStatus !== "closed"
    && record.authorityNotificationRequired !== false
    && !record.authorityNotifiedAt
  );
  const overdueBreaches = activeBreachTimers.filter((record) => Date.parse(record.authorityNotificationDueAt) < Date.now());

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["privacy-governance", activeClientId] });
  }

  async function saveProgram(payload: Record<string, any>) {
    try {
      await saveProgramMutation.mutateAsync({ data: payload as any, params: clientParams });
      await refresh();
      toast({ title: "Privacy profile saved" });
    } catch (error) {
      toast({ title: "Could not save privacy profile", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" });
    }
  }

  async function saveRecord(payload: Record<string, any>) {
    try {
      if (editor?.record) {
        await updateRecordMutation.mutateAsync({
          kind: payload.kind,
          id: editor.record.id,
          data: payload as any,
          params: clientParams,
        });
      } else {
        await createRecordMutation.mutateAsync({ data: payload as any, params: clientParams });
      }
      setEditor(null);
      await refresh();
      toast({ title: editor?.record ? "Record updated" : "Record added" });
    } catch (error) {
      toast({ title: "Could not save record", description: error instanceof Error ? error.message : "Review the fields and try again.", variant: "destructive" });
    }
  }

  async function saveVerification(payload: Record<string, string>) {
    if (!verificationSchedule) return;
    try {
      await verificationMutation.mutateAsync({
        id: verificationSchedule.id,
        data: payload as any,
        params: clientParams,
      });
      setVerificationSchedule(null);
      await refresh();
      toast({ title: "Verification evidence recorded" });
    } catch (error) {
      toast({ title: "Could not record verification", description: error instanceof Error ? error.message : "Review the evidence and try again.", variant: "destructive" });
    }
  }

  if (query.isLoading) {
    return <AppLayout title="Privacy Centre"><div className="mx-auto max-w-7xl p-6 text-sm text-muted-foreground">Loading privacy records…</div></AppLayout>;
  }
  if (query.isError) {
    return <AppLayout title="Privacy Centre"><div className="mx-auto max-w-7xl p-6">
      <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>Privacy records could not be loaded</AlertTitle><AlertDescription>{query.error instanceof Error ? query.error.message : "Try again."}</AlertDescription></Alert>
      <Button className="mt-4" variant="outline" onClick={() => query.refetch()}>Retry</Button>
    </div></AppLayout>;
  }
  if (!activeClientId || !data) {
    return <AppLayout title="Privacy Centre"><div className="mx-auto max-w-7xl p-6"><Alert><AlertTitle>Select a client</AlertTitle><AlertDescription>Choose a client account to manage its privacy records.</AlertDescription></Alert></div></AppLayout>;
  }

  const tabClass = "rounded-md px-3 py-2 text-sm";
  return (
    <AppLayout title="Privacy Centre">
      <div className="mx-auto max-w-7xl space-y-6 p-4 md:p-8">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-xs font-medium text-muted-foreground">
              <Shield className="h-3.5 w-3.5" /> Management records
            </div>
            <h1 className="text-3xl font-bold tracking-tight">Privacy Centre</h1>
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">Keep privacy notices, processing decisions, rights requests, retention controls, providers and incident assessments together.</p>
          </div>
          <Button variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>{query.isFetching ? "Refreshing…" : "Refresh records"}</Button>
        </div>

        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Record-keeping support, not legal advice or certification</AlertTitle>
          <AlertDescription>
            Record decisions for your organisation and review them for each purpose and jurisdiction. Suggested deadlines and classifications do not decide whether a request is valid, a DPIA is required, a transfer is permitted or a notification is legally required. Retention periods are not universal.
          </AlertDescription>
        </Alert>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Card><CardContent className="flex items-center gap-3 p-4"><div className="rounded-lg bg-blue-50 p-2 text-blue-700"><Clock3 className="h-5 w-5" /></div><div><p className="text-2xl font-bold">{activeRequests.length}</p><p className="text-xs text-muted-foreground">Open rights requests</p></div></CardContent></Card>
          <Card className={overdueRequests.length ? "border-red-200" : ""}><CardContent className="flex items-center gap-3 p-4"><div className="rounded-lg bg-red-50 p-2 text-red-700"><AlertTriangle className="h-5 w-5" /></div><div><p className="text-2xl font-bold">{overdueRequests.length}</p><p className="text-xs text-muted-foreground">Overdue request timers</p></div></CardContent></Card>
          <Card><CardContent className="flex items-center gap-3 p-4"><div className="rounded-lg bg-amber-50 p-2 text-amber-700"><ShieldAlert className="h-5 w-5" /></div><div><p className="text-2xl font-bold">{activeHolds.length}</p><p className="text-xs text-muted-foreground">Active holds / exceptions</p></div></CardContent></Card>
          <Card className={overdueBreaches.length ? "border-red-200" : ""}><CardContent className="flex items-center gap-3 p-4"><div className="rounded-lg bg-violet-50 p-2 text-violet-700"><BadgeCheck className="h-5 w-5" /></div><div><p className="text-2xl font-bold">{activeBreachTimers.length}</p><p className="text-xs text-muted-foreground">Open breach assessments</p></div></CardContent></Card>
        </div>

        {overdueRequests.length > 0 && <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>Rights request deadline passed</AlertTitle><AlertDescription>Review {overdueRequests.length} open request(s) and record the next action. The app does not determine whether a deadline extension is legally available.</AlertDescription></Alert>}
        {overdueBreaches.length > 0 && <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>Breach assessment timer passed</AlertTitle><AlertDescription>Review {overdueBreaches.length} incident(s). The 72-hour marker is a tracking aid and does not make a notification decision or send a notice.</AlertDescription></Alert>}

        <Tabs defaultValue="profile" className="space-y-5">
          <TabsList className="h-auto w-full flex-wrap justify-start gap-1">
            <TabsTrigger className={tabClass} value="profile">Roles & notice</TabsTrigger>
            <TabsTrigger className={tabClass} value="activities">Processing activities</TabsTrigger>
            <TabsTrigger className={tabClass} value="requests">Rights requests</TabsTrigger>
            <TabsTrigger className={tabClass} value="retention">Retention & holds</TabsTrigger>
            <TabsTrigger className={tabClass} value="processors">Providers & transfers</TabsTrigger>
            <TabsTrigger className={tabClass} value="breaches">Breach assessments</TabsTrigger>
          </TabsList>

          <TabsContent value="profile">
            <ProgramEditor program={data.program} saving={saving} onSave={saveProgram} />
          </TabsContent>

          <TabsContent value="activities">
            <RecordSection title="Processing activities" description="Record purposes, data subjects and categories, legal-basis assessments, Article 9 conditions, retention criteria and DPIA screening." kind="activity" items={data.activities} saving={saving} verifications={data.retentionVerifications} editor={editor} onAdd={() => setEditor({ kind: "activity" })} onEdit={setEditor} onVerify={setVerificationSchedule} onSave={saveRecord} onCancel={() => setEditor(null)} />
          </TabsContent>

          <TabsContent value="requests">
            <RecordSection title="Data-subject rights requests" description="Track access, rectification, erasure, restriction, objection and portability requests with identity checks, decisions and response evidence." kind="rights_request" items={data.rightsRequests} saving={saving} verifications={data.retentionVerifications} editor={editor} onAdd={() => setEditor({ kind: "rights_request" })} onEdit={setEditor} onVerify={setVerificationSchedule} onSave={saveRecord} onCancel={() => setEditor(null)} />
          </TabsContent>

          <TabsContent value="retention">
            {verificationSchedule && <div className="mb-4"><VerificationEditor schedule={verificationSchedule} saving={saving} onCancel={() => setVerificationSchedule(null)} onSave={saveVerification} /></div>}
            <RecordSection title="Retention schedules" description="Set context-specific criteria, document legal holds and deletion exceptions, then keep dated evidence when deletion or continued retention is checked." kind="retention" items={data.retentionSchedules} saving={saving} verifications={data.retentionVerifications} editor={editor} onAdd={() => setEditor({ kind: "retention" })} onEdit={setEditor} onVerify={setVerificationSchedule} onSave={saveRecord} onCancel={() => setEditor(null)} />
          </TabsContent>

          <TabsContent value="processors">
            <RecordSection title="Processors, subprocessors and transfers" description="Record service scope, processing locations, agreements, transfer mechanisms, safeguards and review dates." kind="processor" items={data.processors} saving={saving} verifications={data.retentionVerifications} editor={editor} onAdd={() => setEditor({ kind: "processor" })} onEdit={setEditor} onVerify={setVerificationSchedule} onSave={saveRecord} onCancel={() => setEditor(null)} />
          </TabsContent>

          <TabsContent value="breaches">
            <RecordSection title="Personal-data breach assessments" description="Capture discovery time, risk decisions, containment and notification status. New incidents receive a 72-hour supervisory-notification tracking marker based on discovery time." kind="breach" items={data.breaches} saving={saving} verifications={data.retentionVerifications} editor={editor} onAdd={() => setEditor({ kind: "breach" })} onEdit={setEditor} onVerify={setVerificationSchedule} onSave={saveRecord} onCancel={() => setEditor(null)} />
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}