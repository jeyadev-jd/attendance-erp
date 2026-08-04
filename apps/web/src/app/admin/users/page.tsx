"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { PageHeader, Card, CardTitle, Button, Input, Select, Field, Alert, Spinner, EmptyState, Badge } from "@/components/ui";
import { userApi, ApiError, type ManagedUser, type StaffRole } from "@/lib/api";
import { useToken } from "@/lib/hooks";
import { useClaims } from "@/store/authStore";

const STAFF_ROLES: StaffRole[] = ["SUPER_ADMIN", "ADMIN", "CLASS_ADMIN", "FACULTY"];

const ROLE_TONE: Record<string, "red" | "amber" | "blue" | "slate" | "green"> = {
  SUPER_ADMIN: "red",
  ADMIN: "amber",
  CLASS_ADMIN: "blue",
  FACULTY: "green",
  STUDENT: "slate",
};

export default function UsersPage() {
  const token = useToken();
  const qc = useQueryClient();
  const claims = useClaims();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<{ email: string; name: string; role: StaffRole; externalId: string }>({
    email: "",
    name: "",
    role: "CLASS_ADMIN",
    externalId: "",
  });
  const [editing, setEditing] = useState<{ id: string; role: StaffRole } | null>(null);

  const staff = useQuery({
    queryKey: ["users", "staff"],
    queryFn: () => userApi.list(token!),
    enabled: !!token,
  });

  function onError(err: unknown) {
    setNotice(null);
    setError(err instanceof ApiError ? err.message : "Request failed");
  }
  function refresh(message: string) {
    setError(null);
    setNotice(message);
    qc.invalidateQueries({ queryKey: ["users"] });
  }

  const create = useMutation({
    mutationFn: () =>
      userApi.create(token!, {
        email: form.email,
        name: form.name,
        role: form.role,
        externalId: form.externalId || undefined,
      }),
    onSuccess: (created) => {
      setForm({ email: "", name: "", role: "CLASS_ADMIN", externalId: "" });
      refresh(
        `${created.name} added as ${created.role.replace("_", " ")}. Temporary password: ${created.temporaryPassword} — they must change it via OTP on first login.`
      );
    },
    onError,
  });

  const updateRole = useMutation({
    mutationFn: () => userApi.update(token!, editing!.id, { role: editing!.role }),
    onSuccess: (updated) => {
      setEditing(null);
      refresh(`${updated.name} is now ${updated.role.replace("_", " ")}.`);
    },
    onError,
  });

  const setActive = useMutation({
    mutationFn: (v: { id: string; isActive: boolean }) => userApi.update(token!, v.id, { isActive: v.isActive }),
    onSuccess: (updated) => refresh(`${updated.name} ${updated.isActive ? "reactivated" : "deactivated"}.`),
    onError,
  });

  const isSelf = (u: ManagedUser) => u.id === claims?.sub;

  return (
    <AppShell>
      <PageHeader title="Admins & staff" subtitle="Who can mark attendance and manage the system" />

      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {notice && <Alert tone="green">{notice}</Alert>}

        <Card>
          <CardTitle>Add staff member</CardTitle>
          <p className="mt-1 text-xs text-slate-500">
            They receive the shared temporary password and must set their own via OTP on first login. To add a
            <strong> student</strong>, use the Students page instead — students need a roll number and section.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Name">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Email">
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="Role">
              <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as StaffRole })}>
                {STAFF_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r.replace("_", " ")}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Employee / UID (optional)">
              <Input value={form.externalId} onChange={(e) => setForm({ ...form, externalId: e.target.value })} />
            </Field>
          </div>
          <Button
            onClick={() => create.mutate()}
            disabled={!form.name || !form.email || create.isPending}
            className="mt-3 w-full sm:w-auto"
          >
            {create.isPending ? "Adding…" : "Add staff member"}
          </Button>
        </Card>

        <Card className="p-0">
          <div className="border-b px-4 py-3">
            <CardTitle>Current staff</CardTitle>
          </div>
          {staff.isLoading ? (
            <Spinner />
          ) : !staff.data?.length ? (
            <EmptyState message="No staff users yet." />
          ) : (
            <ul className="divide-y">
              {staff.data.map((u) => (
                <li key={u.id} className="px-4 py-3">
                  {editing?.id === u.id ? (
                    <div className="space-y-3">
                      <p className="text-sm font-medium">{u.name}</p>
                      <Field label="Role">
                        <Select
                          value={editing.role}
                          onChange={(e) => setEditing({ ...editing, role: e.target.value as StaffRole })}
                        >
                          {STAFF_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r.replace("_", " ")}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <div className="flex gap-2">
                        <Button onClick={() => updateRole.mutate()} disabled={updateRole.isPending}>
                          {updateRole.isPending ? "Saving…" : "Save role"}
                        </Button>
                        <Button variant="secondary" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-medium">{u.name}</p>
                          <Badge tone={ROLE_TONE[u.role] ?? "slate"}>{u.role.replace("_", " ")}</Badge>
                          {!u.isActive && <Badge tone="slate">Inactive</Badge>}
                          {u.hasStudentProfile && <Badge tone="green">Also a student</Badge>}
                        </div>
                        <p className="mt-0.5 truncate text-xs text-slate-500">
                          {u.email}
                          {u.externalId ? ` · ${u.externalId}` : ""}
                          {u.mustChangePassword ? " · password not yet set" : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-3">
                        {/* The API blocks self-edits so an admin can't lock themselves out; hide them here too. */}
                        {!isSelf(u) && (
                          <>
                            <button onClick={() => setEditing({ id: u.id, role: u.role as StaffRole })} className="text-sm text-slate-700">
                              Change role
                            </button>
                            {u.isActive ? (
                              <button
                                onClick={() => {
                                  if (confirm(`Deactivate ${u.name}? They will lose access immediately.`))
                                    setActive.mutate({ id: u.id, isActive: false });
                                }}
                                className="text-sm text-red-600"
                              >
                                Deactivate
                              </button>
                            ) : (
                              <button onClick={() => setActive.mutate({ id: u.id, isActive: true })} className="text-sm text-emerald-700">
                                Reactivate
                              </button>
                            )}
                          </>
                        )}
                        {isSelf(u) && <span className="text-xs text-slate-400">You</span>}
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
