import { useState, useEffect } from "react";
import { format, formatDistanceToNow } from "date-fns";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { useAuth, useIsConsultant, useCanAdmin, useIsManager } from "@/context/auth-context";
import { roleLabel, roleChoiceLabel, ROLE_DESCRIPTIONS, MAINTENANCE_MANAGER_CHOICE } from "@/lib/roles";
import { departmentLabel } from "@/lib/departments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Pencil, Trash2, UserCheck, UserX, Wrench, ShieldOff, Mail, MailX, UsersRound } from "lucide-react";

const NO_DEPT_VALUE = "__none__";

interface User {
  id: number;
  email: string;
  name: string;
  role: string;
  clientId: number | null;
  departmentId: number | null;
  active: boolean;
  totpEnabled?: boolean;
  isMaintenanceManager: boolean;
  isDepartmentManager: boolean;
  allDepartments?: boolean;
  /** Main department first, then a Manager's extra ones. */
  departmentIds?: number[];
  /** A Viewer's staff roster entry (whose training records they see). */
  staffRosterId?: number | null;
  /** Latest password setup link; null when none was ever sent. */
  invitation?: {
    status: "pending" | "expired" | "completed" | "revoked" | "undelivered";
    sentAt: string;
    expiresAt: string;
    revokedAt: string | null;
  } | null;
}

type ActionMessage = { kind: "success" | "error"; text: string };

interface Department {
  id: number;
  name: string;
  clientId: number;
  siteId?: number | null;
  siteName?: string | null;
}

interface RosterEntry {
  id: number;
  name: string;
  email: string | null;
}

/** Roles that cover departments the Owner picks (one, several or all). */
const isManagerChoice = (role: string) => role === "client_manager" || role === MAINTENANCE_MANAGER_CHOICE;

function InvitationState({ invitation }: { invitation: User["invitation"] }) {
  if (!invitation) return null;
  const expiresAt = new Date(invitation.expiresAt);
  const exact = format(expiresAt, "d MMM yyyy, HH:mm");
  if (invitation.status === "pending") {
    return (
      <span className="block text-xs text-amber-700" title={`Setup link expires ${exact}`}>
        <span className="block font-medium">Setup pending</span>
        <span className="block">Link expires in {formatDistanceToNow(expiresAt)} · {format(expiresAt, "d MMM, HH:mm")}</span>
      </span>
    );
  }
  if (invitation.status === "expired") {
    return (
      <span className="block text-xs text-destructive" title={`Setup link expired ${exact}`}>
        Setup link expired {formatDistanceToNow(expiresAt, { addSuffix: true })}
      </span>
    );
  }
  if (invitation.status === "undelivered") {
    return (
      <span className="block text-xs text-destructive">
        <span className="block font-medium">Setup email not delivered</span>
        <span className="block">Check the address, then resend</span>
      </span>
    );
  }
  if (invitation.status === "revoked" && invitation.revokedAt) {
    const revokedAt = new Date(invitation.revokedAt);
    return (
      <span className="block text-xs text-muted-foreground" title={`Setup link revoked ${format(revokedAt, "d MMM yyyy, HH:mm")}`}>
        Setup link revoked {formatDistanceToNow(revokedAt, { addSuffix: true })}
      </span>
    );
  }
  return <span className="block text-xs text-muted-foreground">Password set up</span>;
}

const ROLE_COLORS: Record<string, string> = {
  consultant: "bg-violet-100 text-violet-800",
  client_admin: "bg-blue-100 text-blue-800",
  client_manager: "bg-amber-100 text-amber-800",
  client_staff: "bg-green-100 text-green-800",
  client_viewer: "bg-gray-100 text-gray-700",
};

function UserDialog({
  open,
  onClose,
  onSaved,
  user,
  departments,
  roster,
  clientId,
  isConsultant,
  currentUserId,
  actor,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (notice?: ActionMessage) => void;
  user: User | null;
  departments: Department[];
  roster: RosterEntry[];
  clientId: number | null;
  isConsultant: boolean;
  currentUserId: number | null;
  /** The signed-in user; a Manager adds and edits Staff and Viewers in their own departments. */
  actor: { role: string; departmentId: number | null; departmentIds?: number[]; allDepartments?: boolean } | null;
}) {
  const actorIsManager = actor?.role === "client_manager";
  const editingSelfAsManager = actorIsManager && !!user && user.id === currentUserId;
  // Another user's email and password can't be changed here; they reset their
  // own password from the sign-in page.
  const editingOther = !!user && user.id !== currentUserId;
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    role: "client_viewer",
    departmentId: "",
    // A Manager's departments in the order picked; the first is their main one.
    departmentIds: [] as number[],
    allDepartments: false,
    staffRosterId: "",
    active: true,
  });
  const [saving, setSaving] = useState(false);
  const [resettingTwoFactor, setResettingTwoFactor] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (user) {
      setForm({
        name: user.name,
        email: user.email,
        password: "",
        role: user.role === "client_manager" && user.isMaintenanceManager ? MAINTENANCE_MANAGER_CHOICE : user.role,
        departmentId: user.departmentId?.toString() ?? "",
        departmentIds: user.departmentIds ?? (user.departmentId != null ? [user.departmentId] : []),
        allDepartments: user.allDepartments === true,
        staffRosterId: user.staffRosterId?.toString() ?? "",
        active: user.active,
      });
    } else {
      // A Manager's new people start in the department the Manager is working in.
      const departmentId = actorIsManager && !actor?.allDepartments ? actor?.departmentId?.toString() ?? "" : "";
      setForm({ name: "", email: "", password: "", role: "client_viewer", departmentId, departmentIds: [], allDepartments: false, staffRosterId: "", active: true });
    }
    setError("");
  }, [user, open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const maintenance = form.role === MAINTENANCE_MANAGER_CHOICE;
      const role = maintenance ? "client_manager" : form.role;
      const body: Record<string, unknown> = {
        name: form.name,
        email: form.email,
        role,
        active: form.active,
        clientId,
      };
      // Only Owners and consultants give a Manager several or every department.
      if (!actorIsManager && role === "client_manager") {
        body.allDepartments = form.allDepartments;
        body.departmentIds = form.allDepartments ? [] : form.departmentIds;
      } else {
        body.departmentId = form.departmentId ? Number(form.departmentId) : null;
      }
      if (!actorIsManager) {
        body.allDepartments = role === "client_manager" && form.allDepartments;
        // Choosing Maintenance manager, or moving someone off it, sets the switch.
        if (maintenance || user?.isMaintenanceManager) body.isMaintenanceManager = maintenance;
      }
      if (role === "client_viewer" && (form.staffRosterId || user)) {
        body.staffRosterId = form.staffRosterId ? Number(form.staffRosterId) : null;
      }
      // Password is optional. When creating a user and leaving it blank, the
      // server emails an invite link so they can set their own password.
      if (form.password) body.password = form.password;

      const path = user ? `/users/${user.id}` : "/users";
      const method = user ? "PUT" : "POST";
      const res = await apiFetch(path, { method, body: JSON.stringify(body) });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `Failed to save user (${res.status})`);
      }
      // A new account without a password is invited by email. The account is
      // created even if that email fails, so say which happened.
      const saved = user ? null : await res.json().catch(() => null);
      if (saved?.inviteEmail === "failed") {
        onSaved({
          kind: "error",
          text: `${form.name}'s account was created, but the password setup email to ${form.email} could not be delivered. Check the address, then use the resend button next to their name to try again.`,
        });
      } else if (saved?.inviteEmail === "sent") {
        onSaved({ kind: "success", text: `${form.name}'s account was created and a password setup link was emailed to ${form.email}.` });
      } else {
        onSaved();
      }
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function resetTwoFactor() {
    if (!user) return;
    if (!confirm(`Reset two-factor authentication for ${user.name}? They will be able to sign in with just their password and can re-enrol with a new device.`)) return;

    setResettingTwoFactor(true);
    setError("");
    try {
      const res = await apiFetch(`/users/${user.id}/reset-2fa`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed to reset two-factor authentication");
      }
      onSaved();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to reset two-factor authentication");
    } finally {
      setResettingTwoFactor(false);
    }
  }

  const availableRoles = isConsultant
    ? ["consultant", "client_admin", "client_manager", MAINTENANCE_MANAGER_CHOICE, "client_staff", "client_viewer"]
    : actorIsManager
      ? ["client_staff", "client_viewer"]
      : ["client_admin", "client_manager", MAINTENANCE_MANAGER_CHOICE, "client_staff", "client_viewer"];
  // A Manager picks from their own departments unless they cover them all.
  const actorDepartments = actor?.departmentIds ?? (actor?.departmentId != null ? [actor.departmentId] : []);
  const departmentChoices = actorIsManager && !actor?.allDepartments
    ? departments.filter(d => actorDepartments.includes(d.id))
    : departments;
  const toggleDepartment = (id: number, on: boolean) => setForm(f => ({
    ...f,
    departmentIds: on ? [...f.departmentIds.filter(d => d !== id), id] : f.departmentIds.filter(d => d !== id),
  }));
  const departmentValue = form.departmentId || NO_DEPT_VALUE;

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{user ? "Edit User" : "Add User"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-2">
            <Label>Full Name</Label>
            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
          </div>
          <div className="space-y-2">
            <Label>Email</Label>
            <Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required disabled={editingOther} />
          </div>
          {editingOther ? (
            <p className="text-xs text-muted-foreground">
              Only the user can change their password, using "Forgot password?" on the sign-in page.
            </p>
          ) : (
          <div className="space-y-2">
            <Label>{user ? "New Password (leave blank to keep)" : "Password"}</Label>
            <Input
              type="password"
              value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              minLength={8}
              placeholder={user ? "Leave blank to keep current" : "Min. 8 characters"}
            />
            {!user && (
              <p className="text-xs text-muted-foreground">
                Leave blank to email the user a link to set their own password
              </p>
            )}
          </div>
          )}
          {editingSelfAsManager ? (
            <p className="text-xs text-muted-foreground">
              Your role and departments are set by an Owner.
            </p>
          ) : (
          <>
          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={form.role} onValueChange={v => setForm(f => ({ ...f, role: v }))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableRoles.map(r => (
                  <SelectItem key={r} value={r}>{roleChoiceLabel(r, isConsultant)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {ROLE_DESCRIPTIONS[form.role] && (
              <p className="text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[form.role]}</p>
            )}
          </div>
          {isManagerChoice(form.role) && !actorIsManager && (
            <fieldset className="space-y-2" data-testid="manager-departments">
              <legend className="text-sm font-medium">Departments</legend>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.allDepartments}
                  onChange={e => setForm(f => ({ ...f, allDepartments: e.target.checked }))}
                />
                All departments
              </label>
              {!form.allDepartments && (
                <div className="space-y-1.5 rounded-md border border-border p-2">
                  {departments.length === 0 && <p className="text-xs text-muted-foreground">No departments yet. Add them in Settings first.</p>}
                  {departments.map(d => (
                    <label key={d.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={form.departmentIds.includes(d.id)} onChange={e => toggleDepartment(d.id, e.target.checked)} />
                      {departmentLabel(d)}
                      {form.departmentIds[0] === d.id && form.departmentIds.length > 1 && <span className="text-xs text-muted-foreground">(main)</span>}
                    </label>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                With more than one department they switch between them at the top of the page. The first one ticked is where they start.
              </p>
            </fieldset>
          )}
          {form.role === "client_viewer" && (
            <div className="space-y-2">
              <Label>Name on the staff roster</Label>
              <Select value={form.staffRosterId || NO_DEPT_VALUE} onValueChange={v => setForm(f => ({ ...f, staffRosterId: v === NO_DEPT_VALUE ? "" : v }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick their name..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_DEPT_VALUE}>{user ? "Not linked yet" : "Match by email address"}</SelectItem>
                  {roster.map(r => (
                    <SelectItem key={r.id} value={r.id.toString()}>{r.name}{r.email ? ` (${r.email})` : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">They see and sign off only this person's training records.</p>
            </div>
          )}
          {(form.role === "client_staff" || form.role === "client_viewer") && (
            <div className="space-y-2">
              <Label>Department scope</Label>
              <Select
                value={departmentValue}
                onValueChange={v => setForm(f => ({
                  ...f,
                  departmentId: v === NO_DEPT_VALUE ? "" : v,
                }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select department..." />
                </SelectTrigger>
                <SelectContent>
                  {(!actorIsManager || actor?.allDepartments) && (
                    <SelectItem value={NO_DEPT_VALUE}>No department</SelectItem>
                  )}
                  {departmentChoices.map(d => (
                    <SelectItem key={d.id} value={d.id.toString()}>{departmentLabel(d)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {departments.length === 0 && (
                <p className="text-xs text-muted-foreground" data-testid="text-no-departments">
                  No departments yet. Add them under Settings → Departments, then come back to choose one.
                </p>
              )}
            </div>
          )}
          </>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {user?.totpEnabled && !actorIsManager && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="text-sm font-medium text-amber-900">Two-factor authentication is enabled</p>
              <p className="mt-1 text-xs text-amber-800">
                Reset it only if this user is locked out. They can enrol a new device after signing in.
              </p>
              <Button
                type="button"
                variant="outline"
                className="mt-3 border-amber-300 text-amber-900 hover:bg-amber-100"
                onClick={resetTwoFactor}
                disabled={resettingTwoFactor || saving}
              >
                <ShieldOff className="mr-2 h-4 w-4" />
                {resettingTwoFactor ? "Resetting..." : "Reset 2FA"}
              </Button>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving..." : user ? "Save Changes" : "Add User"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function UsersPage() {
  const { activeClientId, user: currentUser } = useAuth();
  const isConsultant = useIsConsultant();
  const canAdmin = useCanAdmin();
  const isManager = useIsManager();
  const canManageStaff = canAdmin || isManager;
  const [users, setUsers] = useState<User[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [reassigning, setReassigning] = useState<number | null>(null);
  const [resendingInvite, setResendingInvite] = useState<number | null>(null);
  const [revokingInvite, setRevokingInvite] = useState<number | null>(null);
  const [actionMessage, setActionMessage] = useState<ActionMessage | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [usersRes, deptsRes, rosterRes] = await Promise.all([
        apiFetch(`/users${activeClientId ? `?clientId=${activeClientId}` : ""}`),
        apiFetch(`/departments${activeClientId ? `?clientId=${activeClientId}` : ""}`),
        apiFetch("/staff-roster"),
      ]);
      if (usersRes.ok) setUsers(await usersRes.json());
      if (deptsRes.ok) setDepartments(await deptsRes.json());
      if (rosterRes.ok) setRoster(await rosterRes.json());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [activeClientId]);

  async function deleteUser(id: number) {
    if (!confirm("Remove this user?")) return;
    setActionMessage(null);
    const res = await apiFetch(`/users/${id}`, { method: "DELETE" });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setActionMessage({ kind: "error", text: data?.error ?? "Failed to remove user" });
    } else if (data?.deactivated) {
      // Users named in the audit trail are kept, deactivated, so the record stays complete.
      setActionMessage({ kind: "success", text: `${data.name} has recorded activity in the audit trail, so they were deactivated rather than removed.` });
    }
    load();
  }

  async function toggleActive(user: User) {
    await apiFetch(`/users/${user.id}`, {
      method: "PUT",
      body: JSON.stringify({ active: !user.active }),
    });
    load();
  }

  async function toggleMaintenanceManager(user: User) {
    await apiFetch(`/users/${user.id}`, {
      method: "PUT",
      body: JSON.stringify({ isMaintenanceManager: !user.isMaintenanceManager }),
    });
    load();
  }

  async function toggleDepartmentManager(user: User) {
    await apiFetch(`/users/${user.id}`, {
      method: "PUT",
      body: JSON.stringify({ isDepartmentManager: !user.isDepartmentManager }),
    });
    load();
  }

  async function resendInvite(user: User) {
    if (!confirm(`Send a fresh password setup link to ${user.name} at ${user.email}? Any older unused setup links will stop working.`)) return;
    setResendingInvite(user.id);
    setActionMessage(null);
    try {
      const res = await apiFetch(`/users/${user.id}/resend-invite`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error ?? "Failed to resend password setup link");
      }
      setActionMessage({ kind: "success", text: `A fresh password setup link was sent to ${user.email}.` });
      await load();
    } catch (err: unknown) {
      setActionMessage({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to resend password setup link",
      });
      // A failed delivery cancels the new link; show that state in the list.
      await load();
    } finally {
      setResendingInvite(null);
    }
  }

  async function revokeInvite(user: User) {
    if (!confirm(`Revoke the password setup link sent to ${user.name} at ${user.email}? The link stops working straight away and no new email is sent.`)) return;
    setRevokingInvite(user.id);
    setActionMessage(null);
    try {
      const res = await apiFetch(`/users/${user.id}/revoke-invite`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error ?? "Failed to revoke the password setup link");
      }
      setActionMessage({ kind: "success", text: `The password setup link for ${user.email} was revoked and no longer works.` });
      await load();
    } catch (err: unknown) {
      setActionMessage({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to revoke the password setup link",
      });
    } finally {
      setRevokingInvite(null);
    }
  }

  async function reassignDept(user: User, value: string) {
    const departmentId = value === NO_DEPT_VALUE ? null : Number(value);
    const previousDepartmentId = user.departmentId;
    const setRowDepartment = (id: number | null) =>
      setUsers(rows => rows.map(row => (row.id === user.id ? { ...row, departmentId: id } : row)));
    setReassigning(user.id);
    setActionMessage(null);
    // Show the choice while it saves; a rejected save puts the previous
    // department back so the row never shows a scope the server refused.
    setRowDepartment(departmentId);
    try {
      const res = await apiFetch(`/users/${user.id}`, {
        method: "PUT",
        body: JSON.stringify({ departmentId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `The server rejected the change (${res.status}).`);
      }
    } catch (err: unknown) {
      setRowDepartment(previousDepartmentId);
      setActionMessage({
        kind: "error",
        text: `${user.name}'s department wasn't changed. ${err instanceof Error ? err.message : "Please try again."}`,
      });
      return;
    } finally {
      setReassigning(null);
    }
    await load();
  }

  return (
    <AppLayout title="User Management">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground text-sm">
            {isManager ? "Add and look after the Staff and Viewers in your departments" : "Manage user accounts and access levels"}
          </p>
          <Button onClick={() => { setEditingUser(null); setDialogOpen(true); }}>
            <Plus className="w-4 h-4 mr-2" />
            Add User
          </Button>
        </div>
        <details className="rounded-xl border border-border bg-card px-4 py-3 text-sm" data-testid="role-descriptions">
          <summary className="cursor-pointer font-medium">What each role can do</summary>
          <dl className="mt-3 space-y-2">
            {(isConsultant ? ["consultant"] : []).concat(["client_admin", "client_manager", MAINTENANCE_MANAGER_CHOICE, "client_staff", "client_viewer"]).map(r => (
              <div key={r}>
                <dt className="font-medium">{roleChoiceLabel(r, isConsultant)}</dt>
                <dd className="text-muted-foreground">{ROLE_DESCRIPTIONS[r]}</dd>
              </div>
            ))}
          </dl>
        </details>
        {actionMessage && (
          <p
            className={`rounded-md border px-3 py-2 text-sm ${
              actionMessage.kind === "success"
                ? "border-green-200 bg-green-50 text-green-800"
                : "border-destructive/30 bg-destructive/5 text-destructive"
            }`}
            role={actionMessage.kind === "error" ? "alert" : "status"}
          >
            {actionMessage.text}
          </p>
        )}

        {loading ? (
          <div className="text-center py-16 text-muted-foreground">Loading users...</div>
        ) : (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <table className="w-full">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-4 py-3 text-sm font-medium text-muted-foreground">Name</th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-muted-foreground">Email</th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-muted-foreground">Role</th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-muted-foreground">Department</th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-muted-foreground">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {users.map(u => {
                  const userDepartments = (u.departmentIds ?? (u.departmentId != null ? [u.departmentId] : []))
                    .map(id => departmentLabel(departments.find(d => d.id === id)))
                    .filter((name): name is string => !!name);
                  const self = u.id === currentUser?.id;
                  const seesAllDepartments = u.role === "consultant" || u.role === "client_admin"
                    || (u.role === "client_manager" && u.allDepartments === true);
                  const rosterName = u.role === "client_viewer"
                    ? roster.find(r => r.id === u.staffRosterId)?.name ?? null
                    : null;
                  return (
                    <tr key={u.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 text-sm">
                        <span className="font-medium">{u.name}</span>
                        {u.role === "client_viewer" && (
                          <span className="block text-xs text-muted-foreground">
                            {rosterName ? `Training records of ${rosterName}` : "Not linked to the staff roster yet"}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">{u.email}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${ROLE_COLORS[u.role] ?? "bg-gray-100 text-gray-700"}`}>
                          {roleLabel(u.role, isConsultant)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {canAdmin && u.role !== "client_manager" ? (
                          <Select
                            value={u.departmentId?.toString() ?? NO_DEPT_VALUE}
                            onValueChange={val => reassignDept(u, val)}
                            disabled={reassigning === u.id}
                          >
                            <SelectTrigger className="h-7 text-xs w-56 border-transparent hover:border-input bg-transparent hover:bg-muted/40 transition-colors">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NO_DEPT_VALUE} className="text-xs text-muted-foreground">
                                {seesAllDepartments ? "All departments" : "No department"}
                              </SelectItem>
                              {departments.map(d => (
                                <SelectItem key={d.id} value={d.id.toString()} className="text-xs">
                                  {departmentLabel(d)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="text-sm text-muted-foreground">
                            {seesAllDepartments ? "All departments" : userDepartments.length ? userDepartments.join(", ") : "No department"}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 text-xs font-medium ${u.active ? "text-green-600" : "text-muted-foreground"}`}>
                          {u.active ? <UserCheck className="w-3 h-3" /> : <UserX className="w-3 h-3" />}
                          {u.active ? "Active" : "Inactive"}
                        </span>
                        <InvitationState invitation={u.invitation} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {canAdmin && u.role === "client_staff" && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => toggleDepartmentManager(u)}
                              disabled={!u.departmentId}
                              title={!u.departmentId ? "Assign a department before making this user a department manager"
                                : u.isDepartmentManager ? "Remove department manager digest access" : "Make department manager (receive relevant track summaries)"}
                              aria-label={u.isDepartmentManager ? `Remove department manager role from ${u.name}` : `Make ${u.name} a department manager`}
                            >
                              <UsersRound className={`w-4 h-4 ${u.isDepartmentManager ? "text-primary" : "text-muted-foreground"}`} />
                            </Button>
                          )}
                          {canAdmin && u.role === "client_staff" && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => toggleMaintenanceManager(u)}
                              title={u.isMaintenanceManager ? "Remove maintenance manager access" : "Make maintenance manager (FixTrack full access)"}
                            >
                              <Wrench className={`w-4 h-4 ${u.isMaintenanceManager ? "text-amber-600" : "text-muted-foreground"}`} />
                            </Button>
                          )}
                          {canManageStaff && u.role === "client_staff" && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => resendInvite(u)}
                              disabled={resendingInvite === u.id}
                              title="Resend password setup link"
                              aria-label={`Resend password setup link to ${u.name}`}
                            >
                              <Mail className={`w-4 h-4 ${resendingInvite === u.id ? "animate-pulse text-primary" : "text-muted-foreground"}`} />
                            </Button>
                          )}
                          {canManageStaff && u.role === "client_staff" && u.invitation?.status === "pending" && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => revokeInvite(u)}
                              disabled={revokingInvite === u.id}
                              title="Revoke password setup link"
                              aria-label={`Revoke password setup link for ${u.name}`}
                            >
                              <MailX className={`w-4 h-4 ${revokingInvite === u.id ? "animate-pulse text-destructive" : "text-destructive"}`} />
                            </Button>
                          )}
                          {!(isManager && self) && (
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => toggleActive(u)} title={u.active ? "Deactivate" : "Activate"}>
                            {u.active ? <UserX className="w-4 h-4 text-muted-foreground" /> : <UserCheck className="w-4 h-4 text-green-600" />}
                          </Button>
                          )}
                          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${u.name}`} onClick={() => { setEditingUser(u); setDialogOpen(true); }}>
                            <Pencil className="w-4 h-4 text-muted-foreground" />
                          </Button>
                          {!(isManager && self) && (
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => deleteUser(u.id)}>
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-16 text-center text-muted-foreground text-sm">
                      No users yet. Add the first user to get started.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <UserDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSaved={(notice) => {
          setActionMessage(notice ?? null);
          load();
        }}
        user={editingUser}
        departments={departments}
        roster={roster}
        clientId={activeClientId}
        isConsultant={isConsultant}
        currentUserId={currentUser?.id ?? null}
        actor={currentUser ? { role: currentUser.role, departmentId: currentUser.departmentId, departmentIds: currentUser.departmentIds, allDepartments: currentUser.allDepartments } : null}
      />
    </AppLayout>
  );
}
