"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { PageHeader, Card, CardTitle, Button, Input, Select, Field, Alert, Spinner, EmptyState } from "@/components/ui";
import { hourConfigApi, ApiError } from "@/lib/api";
import { useSemesters, useToken, DAY_NAMES } from "@/lib/hooks";

type HourRow = { hourNumber: number; startTime: string; endTime: string };

export default function HourConfigPage() {
  const token = useToken();
  const qc = useQueryClient();
  const { semesters, semesterId, setSemesterId } = useSemesters();
  const [dayOfWeek, setDayOfWeek] = useState(1); // Monday — most schedules start here
  const [rows, setRows] = useState<HourRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const configs = useQuery({
    queryKey: ["hour-config", semesterId],
    queryFn: () => hourConfigApi.list(token!, semesterId),
    enabled: !!token && !!semesterId,
  });

  const existing = configs.data?.[String(dayOfWeek)] ?? [];

  const save = useMutation({
    mutationFn: () => hourConfigApi.setDay(token!, { semesterId, dayOfWeek, hours: rows }),
    onSuccess: () => {
      setError(null);
      setSaved(true);
      setRows([]);
      qc.invalidateQueries({ queryKey: ["hour-config"] });
    },
    onError: (err) => {
      setSaved(false);
      setError(err instanceof ApiError ? err.message : "Could not save hours");
    },
  });

  const removeHour = useMutation({
    mutationFn: (id: string) => hourConfigApi.remove(token!, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hour-config"] }),
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not delete hour"),
  });

  function startEditing() {
    // Seed the editor from what's already saved so admins tweak rather than retype.
    setRows(
      existing.length
        ? existing.map((h) => ({ hourNumber: h.hourNumber, startTime: h.startTime, endTime: h.endTime }))
        : [{ hourNumber: 1, startTime: "09:00", endTime: "09:50" }]
    );
    setSaved(false);
  }

  function addRow() {
    const next = rows.length ? Math.max(...rows.map((r) => r.hourNumber)) + 1 : 1;
    setRows([...rows, { hourNumber: next, startTime: "", endTime: "" }]);
  }

  return (
    <AppShell>
      <PageHeader
        title="Hour configuration"
        subtitle="Period timings per weekday — days may have different hour counts"
        action={
          <Select value={semesterId} onChange={(e) => setSemesterId(e.target.value)} className="w-auto min-w-[10rem]">
            {semesters.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        }
      />

      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {saved && <Alert tone="green">Hours saved.</Alert>}

        <Card>
          <Field label="Day of week">
            <Select
              value={dayOfWeek}
              onChange={(e) => {
                setDayOfWeek(Number(e.target.value));
                setRows([]);
                setSaved(false);
              }}
            >
              {DAY_NAMES.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
        </Card>

        <Card className="p-0">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <CardTitle>{DAY_NAMES[dayOfWeek]} hours</CardTitle>
            {!rows.length && (
              <button onClick={startEditing} className="text-sm text-slate-700">
                {existing.length ? "Edit" : "Set hours"}
              </button>
            )}
          </div>

          {configs.isLoading ? (
            <Spinner />
          ) : rows.length ? (
            <div className="space-y-3 p-4">
              {rows.map((row, i) => (
                <div key={i} className="grid grid-cols-3 gap-2">
                  <Field label="Hour">
                    <Input
                      type="number"
                      value={row.hourNumber}
                      onChange={(e) => {
                        const copy = [...rows];
                        copy[i] = { ...row, hourNumber: Number(e.target.value) };
                        setRows(copy);
                      }}
                    />
                  </Field>
                  <Field label="Start">
                    <Input
                      type="time"
                      value={row.startTime}
                      onChange={(e) => {
                        const copy = [...rows];
                        copy[i] = { ...row, startTime: e.target.value };
                        setRows(copy);
                      }}
                    />
                  </Field>
                  <Field label="End">
                    <Input
                      type="time"
                      value={row.endTime}
                      onChange={(e) => {
                        const copy = [...rows];
                        copy[i] = { ...row, endTime: e.target.value };
                        setRows(copy);
                      }}
                    />
                  </Field>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={addRow}>
                  Add hour
                </Button>
                <Button
                  onClick={() => save.mutate()}
                  disabled={save.isPending || rows.some((r) => !r.startTime || !r.endTime)}
                >
                  {save.isPending ? "Saving…" : "Save"}
                </Button>
                <Button variant="secondary" onClick={() => setRows([])}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : !existing.length ? (
            <EmptyState message={`No hours configured for ${DAY_NAMES[dayOfWeek]}.`} />
          ) : (
            <ul className="divide-y">
              {existing.map((h) => (
                <li key={h.id} className="flex items-center justify-between px-4 py-3">
                  <p className="text-sm">
                    <span className="font-medium">Hour {h.hourNumber}</span>
                    <span className="ml-2 text-slate-500">
                      {h.startTime} – {h.endTime}
                    </span>
                  </p>
                  <button onClick={() => removeHour.mutate(h.id)} className="text-sm text-red-600">
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
