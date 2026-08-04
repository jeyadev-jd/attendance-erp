"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { PageHeader, Card, CardTitle, Button, Input, Field, Alert, Spinner } from "@/components/ui";
import { settingsApi, ApiError, type SettingsData } from "@/lib/api";
import { useToken } from "@/lib/hooks";

const FIELDS: { key: keyof SettingsData; label: string; hint: string }[] = [
  { key: "minAttendancePct", label: "Minimum attendance %", hint: "Threshold used for risk levels and safe-bunk maths" },
  { key: "gracePeriodMinutes", label: "Grace period (min)", hint: "Arrivals within this window still count as present" },
  { key: "lateThresholdMinutes", label: "Late threshold (min)", hint: "Beyond grace, up to this is marked LATE" },
  { key: "veryLateThresholdMinutes", label: "Very late threshold (min)", hint: "Beyond this counts as absent" },
  { key: "editWindowHours", label: "Edit window (hours)", hint: "How long staff may edit marks; SUPER_ADMIN can override" },
  { key: "autoLockAfterDays", label: "Auto-lock after (days)", hint: "Records become immutable after this many days" },
];

export default function SettingsPage() {
  const token = useToken();
  const qc = useQueryClient();
  const [form, setForm] = useState<SettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.get(token!),
    enabled: !!token,
  });

  useEffect(() => {
    if (settings.data && !form) setForm(settings.data);
  }, [settings.data, form]);

  const save = useMutation({
    mutationFn: () => settingsApi.update(token!, form!),
    onSuccess: () => {
      setError(null);
      setSaved(true);
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err) => {
      setSaved(false);
      setError(err instanceof ApiError ? err.message : "Could not save settings");
    },
  });

  return (
    <AppShell>
      <PageHeader title="Settings" subtitle="Organization-wide attendance rules — nothing here is hardcoded" />

      {settings.isLoading || !form ? (
        <Card>
          <Spinner />
        </Card>
      ) : (
        <Card>
          <CardTitle>Attendance policy</CardTitle>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <div key={f.key}>
                <Field label={f.label}>
                  <Input
                    type="number"
                    value={form[f.key]}
                    onChange={(e) => {
                      setSaved(false);
                      setForm({ ...form, [f.key]: Number(e.target.value) });
                    }}
                  />
                </Field>
                <p className="mt-1 text-xs text-slate-500">{f.hint}</p>
              </div>
            ))}
          </div>

          {error && (
            <div className="mt-4">
              <Alert>{error}</Alert>
            </div>
          )}
          {saved && (
            <div className="mt-4">
              <Alert tone="green">Settings saved.</Alert>
            </div>
          )}

          <Button onClick={() => save.mutate()} disabled={save.isPending} className="mt-4 w-full sm:w-auto">
            {save.isPending ? "Saving…" : "Save settings"}
          </Button>
        </Card>
      )}
    </AppShell>
  );
}
