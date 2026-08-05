"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { PageHeader, Card, CardTitle, Button, Input, Select, Field, Alert, Spinner, EmptyState, Badge, cn } from "@/components/ui";
import { attendanceApi, ApiError, type MarkableStatus, type MarkStudentRow } from "@/lib/api";
import { useSections, useSemesters, useToken, toDateInput } from "@/lib/hooks";
import { useClaims } from "@/store/authStore";

const STATUSES: MarkableStatus[] = ["PRESENT", "ABSENT", "LATE", "OD"];

const STATUS_STYLE: Record<MarkableStatus, string> = {
  PRESENT: "bg-emerald-600 text-white",
  ABSENT: "bg-red-600 text-white",
  LATE: "bg-amber-500 text-white",
  OD: "bg-blue-600 text-white",
};

const HOURS = [1, 2, 3, 4, 5, 6, 7];

export default function MarkAttendancePage() {
  const token = useToken();
  const qc = useQueryClient();
  const claims = useClaims();
  const { semesterId } = useSemesters();
  const sections = useSections(semesterId);

  const [date, setDate] = useState(toDateInput(new Date()));
  const [sectionId, setSectionId] = useState("");
  const [hourNumber, setHourNumber] = useState(1);
  const [draft, setDraft] = useState<Record<string, MarkableStatus>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ row: MarkStudentRow; status: MarkableStatus; reason: string } | null>(null);

  const markList = useQuery({
    queryKey: ["mark-list", date, sectionId, hourNumber],
    queryFn: () => attendanceApi.getMarkList(token!, date, sectionId, hourNumber),
    enabled: !!token && !!sectionId && !!date,
    retry: false,
  });

  // Reset unsaved choices whenever the slot changes so drafts never leak across hours.
  useEffect(() => {
    setDraft({});
    setNotice(null);
    setError(null);
  }, [date, sectionId, hourNumber]);

  const save = useMutation({
    mutationFn: () =>
      attendanceApi.postMark(token!, {
        date,
        sectionId,
        hourNumber,
        records: Object.entries(draft).map(([studentId, status]) => ({ studentId, status })),
      }),
    onSuccess: (res) => {
      setError(null);
      setNotice(
        `Saved ${res.written} record${res.written === 1 ? "" : "s"}` +
          (res.skippedLocked.length ? ` — ${res.skippedLocked.length} skipped (locked)` : "")
      );
      setDraft({});
      qc.invalidateQueries({ queryKey: ["mark-list"] });
    },
    onError: (err) => {
      setNotice(null);
      setError(err instanceof ApiError ? err.message : "Could not save attendance");
    },
  });

  const edit = useMutation({
    mutationFn: () => attendanceApi.edit(token!, editing!.row.attendanceId!, editing!.status, editing!.reason),
    onSuccess: () => {
      setError(null);
      setNotice("Record updated and logged.");
      setEditing(null);
      qc.invalidateQueries({ queryKey: ["mark-list"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not edit record"),
  });

  const lock = useMutation({
    mutationFn: () => attendanceApi.lock(token!, { date, sectionId, hourNumber }),
    onSuccess: (res) => {
      setNotice(`Locked ${res.locked} records — they are now immutable.`);
      qc.invalidateQueries({ queryKey: ["mark-list"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not lock records"),
  });

  const students = markList.data?.students ?? [];
  const statusOf = (row: MarkStudentRow) => draft[row.studentId] ?? (row.status as MarkableStatus | null);
  const unsaved = Object.keys(draft).length;
  const canLock = claims?.role === "SUPER_ADMIN" || claims?.role === "ADMIN";

  function setAll(status: MarkableStatus) {
    const next: Record<string, MarkableStatus> = {};
    for (const s of students) if (!s.isLocked) next[s.studentId] = status;
    setDraft(next);
  }

  return (
    <AppShell>
      <PageHeader title="Mark attendance" subtitle="Pick a date, section and hour" />

      <div className="space-y-4">
        <Card>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Date">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Section">
              <Select value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
                <option value="">Select…</option>
                {sections.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    Section {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Hour">
              <Select value={hourNumber} onChange={(e) => setHourNumber(Number(e.target.value))}>
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    Hour {h}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>

        {error && <Alert>{error}</Alert>}
        {notice && <Alert tone="green">{notice}</Alert>}

        {!sectionId ? (
          <Card>
            <EmptyState message="Choose a section to load the roster." />
          </Card>
        ) : markList.isLoading ? (
          <Card>
            <Spinner />
          </Card>
        ) : markList.error ? (
          // The API refuses holidays and hours with attendance disabled — surface that reason as-is.
          <Alert>{markList.error instanceof ApiError ? markList.error.message : "Cannot mark this hour"}</Alert>
        ) : (
          <>
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle>{markList.data?.subject?.name ?? "—"}</CardTitle>
                    {(markList.data?.durationHours ?? 1) > 1 && (
                      <Badge tone="blue">
                        {markList.data!.durationHours}-hour block · marked once
                      </Badge>
                    )}
                    {markList.data && !markList.data.countsForAttendance && (
                      <Badge tone="slate">Not counted in %</Badge>
                    )}
                    {markList.data?.isOverride && (
                      <Badge tone="amber">
                        Changed for this date{markList.data.overrideReason ? ` · ${markList.data.overrideReason}` : ""}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {markList.data?.faculty?.name} ·{" "}
                    {markList.data && markList.data.coveredHours.length > 1
                      ? `Hours ${markList.data.coveredHours[0]}–${markList.data.coveredHours.at(-1)}`
                      : `Hour ${markList.data?.hourNumber ?? hourNumber}`}{" "}
                    · {students.length} students
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => setAll("PRESENT")} className="px-3 text-xs">
                    All present
                  </Button>
                  <Button variant="secondary" onClick={() => setAll("ABSENT")} className="px-3 text-xs">
                    All absent
                  </Button>
                  {unsaved > 0 && (
                    <Button variant="secondary" onClick={() => setDraft({})} className="px-3 text-xs">
                      Clear
                    </Button>
                  )}
                  {canLock && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        if (confirm("Lock this hour? Locked records can't be edited.")) lock.mutate();
                      }}
                      className="px-3 text-xs"
                    >
                      Lock hour
                    </Button>
                  )}
                </div>
              </div>
            </Card>

            <Card className="p-0">
              {!students.length ? (
                <EmptyState message="No active students in this section." />
              ) : (
                <ul className="divide-y">
                  {students.map((row) => {
                    const current = statusOf(row);
                    return (
                      <li key={row.studentId} className="px-4 py-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">
                              {row.rollNo} · {row.name}
                            </p>
                            {row.isLocked && <Badge tone="slate">Locked</Badge>}
                          </div>
                          {row.attendanceId && !row.isLocked && (
                            <button
                              onClick={() =>
                                setEditing({ row, status: (row.status as MarkableStatus) ?? "PRESENT", reason: "" })
                              }
                              className="shrink-0 text-xs text-slate-600"
                            >
                              Edit
                            </button>
                          )}
                        </div>

                        {/* Full-width segmented control — easy to hit one-handed on a phone. */}
                        <div className="mt-2 grid grid-cols-4 gap-1">
                          {STATUSES.map((s) => (
                            <button
                              key={s}
                              disabled={row.isLocked}
                              onClick={() => setDraft({ ...draft, [row.studentId]: s })}
                              className={cn(
                                "min-h-[40px] rounded-md border text-xs font-medium disabled:opacity-40",
                                current === s ? STATUS_STYLE[s] : "bg-white text-slate-600"
                              )}
                            >
                              {s}
                            </button>
                          ))}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </>
        )}
      </div>

      {editing && (
        <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/40 sm:items-center sm:p-4">
          <div className="w-full max-w-md rounded-t-xl bg-white p-4 sm:rounded-xl">
            <CardTitle>
              Edit {editing.row.rollNo} · {editing.row.name}
            </CardTitle>
            <div className="mt-3 space-y-3">
              <Field label="New status">
                <Select
                  value={editing.status}
                  onChange={(e) => setEditing({ ...editing, status: e.target.value as MarkableStatus })}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Reason (required)">
                <Input
                  value={editing.reason}
                  onChange={(e) => setEditing({ ...editing, reason: e.target.value })}
                  placeholder="e.g. Medical certificate produced"
                />
              </Field>
            </div>
            <div className="mt-4 flex gap-2">
              <Button
                onClick={() => edit.mutate()}
                disabled={editing.reason.trim().length < 3 || edit.isPending}
                className="flex-1"
              >
                {edit.isPending ? "Saving…" : "Save change"}
              </Button>
              <Button variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Sticky save bar sits above the mobile bottom nav so it stays reachable on long rosters. */}
      {unsaved > 0 && (
        <div className="fixed inset-x-0 bottom-14 z-20 border-t bg-white p-3 lg:bottom-0 lg:ml-60">
          <Button onClick={() => save.mutate()} disabled={save.isPending} className="w-full">
            {save.isPending ? "Saving…" : `Save ${unsaved} change${unsaved === 1 ? "" : "s"}`}
          </Button>
        </div>
      )}
    </AppShell>
  );
}
