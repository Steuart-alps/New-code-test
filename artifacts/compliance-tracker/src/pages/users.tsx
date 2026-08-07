import { useState, useEffect } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { useAuth, useIsConsultant, useCanAdmin } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Pencil, Trash2, UserCheck, UserX, Wrench } from "lucide-react";

const NO_DEPT_VALUE = "__none__";

interface User {
  id: number;
  email: string;
  name: string;
  role: string;
  clientId: number | null;
  departmentId: number | null;
  active: boolean;
  isMaintenanceManager: boolean;
}

interface Department {
  id: number;
  name: string;
  clientId: number;
}

const ROLE_LABELS: Record<string, string> = {
  consultant: "Owner",
  client_admin: "Admin",
  client_staff: "Staff",
  client_viewer: "Viewer",
};

const ROLE_COLORS: Record<string, string> = {
  consultant: "bg-violet-100 text-violet-800",
  client_admin: "bg-blue-100 text-blue-800",
  client_staff: "bg-green-100 text-green-800",
  client_viewer: "bg-gray-100 text-gray-700",
};

function UserDialog({
  open,
  onClose,
  onSaved,
  user,
  departments,
  clientId,
  isConsultant,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  user: User | null;
  departments: Department[];
  clientId: number | null;
  isConsultant: boolean;
}) {
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    role: "client_viewer",
    departmentId: "",
    active: true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (user) {
      setForm({
        name: user.name,
        email: user.email,
        password: "",
        role: user.role,
        departmentId: user.departmentId?.toString() ?? "",
        active: user.active,
      });
    } else {
      setForm({ name: "", email: "", password: "", role: "client_viewer", departmentId: "", active: true });
    }
    setError("");
  }, [user, open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const body: Record<string, unknown> = {
        name: form.name,
        email: form.email,
        role: form.role,
        departmentId: form.departmentId ? Number(form.departmentId) : null,
        active: form.active,
        clientId,
      };
      if (form.password) body.password = form.password;
      if (!user) body.password = form.password;

      const path = user ? `/users/${user.id}` : "/users";
      const method = user ? "PUT" : "POST";
      const res = await apiFetch(path, { method, body: JSON.stringify(body) });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error ?? "Failed to save");
      }
      onSaved();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const availableRoles = isConsultant
    ? ["consultant", "client_admin", "client_staff", "client_viewer"]
    : ["client_admin", "client_staff", "client_viewer"];

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
            <Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required />
          </div>
          <div className="space-y-2">
            <Label>{user ? "New Password (leave blank to keep)" : "Password"}</Label>
            <Input
              type="password"
              value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              required={!user}
              minLength={8}
              placeholder={user ? "Leave blank to keep current" : "Min. 8 characters"}
            />
          </div>
          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={form.role} onValueChange={v => setForm(f => ({ ...f, role: v }))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableRoles.map(r => (
                  <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {(form.role === "client_staff" || form.role === "client_viewer") && (
            <div className="space-y-2">
              <Label>Department scope</Label>
              <Select value={form.departmentId} onValueChange={v => setForm(f => ({ ...f, departmentId: v }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Select department..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">No department</SelectItem>
                  {departments.map(d => (
                    <SelectItem key={d.id} value={d.id.toString()}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
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
  const { activeClientId } = useAuth();
  const isConsultant = useIsConsultant();
  const canAdmin = useCanAdmin();
  const [users, setUsers] = useState<User[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [reassigning, setReassigning] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [usersRes, deptsRes] = await Promise.all([
        apiFetch(`/users${activeClientId ? `?clientId=${activeClientId}` : ""}`),
        apiFetch(`/departments${activeClientId ? `?clientId=${activeClientId}` : ""}`),
      ]);
      if (usersRes.ok) setUsers(await usersRes.json());
      if (deptsRes.ok) setDepartments(await deptsRes.json());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [activeClientId]);

  async function deleteUser(id: number) {
    if (!confirm("Remove this user?")) return;
    await apiFetch(`/users/${id}`, { method: "DELETE" });
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

  async function reassignDept(userId: number, value: string) {
    const departmentId = value === NO_DEPT_VALUE ? null : Number(value);
    setReassigning(userId);
    try {
      await apiFetch(`/users/${userId}`, {
        method: "PUT",
        body: JSON.stringify({ departmentId }),
      });
      await load();
    } finally {
      setReassigning(null);
    }
  }

  return (
    <AppLayout title="User Management">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground text-sm">Manage user accounts and access levels</p>
          <Button onClick={() => { setEditingUser(null); setDialogOpen(true); }}>
            <Plus className="w-4 h-4 mr-2" />
            Add User
          </Button>
        </div>

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
                  const dept = departments.find(d => d.id === u.departmentId);
                  return (
                    <tr key={u.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 font-medium text-sm">{u.name}</td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">{u.email}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${ROLE_COLORS[u.role] ?? "bg-gray-100 text-gray-700"}`}>
                          {ROLE_LABELS[u.role] ?? u.role}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {canAdmin ? (
                          <Select
                            value={u.departmentId?.toString() ?? NO_DEPT_VALUE}
                            onValueChange={val => reassignDept(u.id, val)}
                            disabled={reassigning === u.id}
                          >
                            <SelectTrigger className="h-7 text-xs w-44 border-transparent hover:border-input bg-transparent hover:bg-muted/40 transition-colors">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NO_DEPT_VALUE} className="text-xs text-muted-foreground">
                                All departments
                              </SelectItem>
                              {departments.map(d => (
                                <SelectItem key={d.id} value={d.id.toString()} className="text-xs">
                                  {d.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="text-sm text-muted-foreground">
                            {dept?.name ?? "All departments"}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 text-xs font-medium ${u.active ? "text-green-600" : "text-muted-foreground"}`}>
                          {u.active ? <UserCheck className="w-3 h-3" /> : <UserX className="w-3 h-3" />}
                          {u.active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
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
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => toggleActive(u)} title={u.active ? "Deactivate" : "Activate"}>
                            {u.active ? <UserX className="w-4 h-4 text-muted-foreground" /> : <UserCheck className="w-4 h-4 text-green-600" />}
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setEditingUser(u); setDialogOpen(true); }}>
                            <Pencil className="w-4 h-4 text-muted-foreground" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => deleteUser(u.id)}>
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
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
        onSaved={load}
        user={editingUser}
        departments={departments}
        clientId={activeClientId}
        isConsultant={isConsultant}
      />
    </AppLayout>
  );
}
