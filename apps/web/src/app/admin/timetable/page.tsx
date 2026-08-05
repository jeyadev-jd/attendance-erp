"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import {
  PageHeader,
  Card,
  CardTitle,
  Button,
  Input,
  Select,
  Field,
  Alert,
  Spinner,
  EmptyState,
  Badge,
  cn,
} from "@/components/ui";
import {
  timetableApi,
  timetableOverrideApi,
  subjectApi,
  facultyApi,
  ApiError,
  type TimetableEntry,
} from "@/lib/api";
import { useSections, useSemesters, useToken, DAY_NAMES, DAY_SHORT, toDateInput } from "@/lib/hooks";

const HOURS = [1, 2, 3, 4, 5, 6, 7];
const WEEKDAYS = [1, 2, 3, 4, 5, 6]; // Mon–Sat; Sunday is a holiday

/** Modes are mutually exclusive so a click on the grid always has one clear meaning. */
type Mode = "edit" | "select" | "swap";

type SlotRef = { dayOfWeek: number; hourNumber: number };
const slotKey = (s: SlotRef) => `${s.dayOfWeek}-${s.hourNumber}`;

export default function TimetablePage() {
  const token = useToken();
  const qc = useQueryClient();
  const { semesters, semesterId, setSemesterId } = useSemesters();
  const sections = useSections(semesterId);
  const [sectionId, setSectionId] = useState("");
  const [mode, setMode] = useState<Mode>("edit");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // edit mode
  const [slot, setSlot] = useState<SlotRef | null>(null);
  const [form, setForm] = useState({ subjectId: "", facultyId: "", durationHours: 1 });

  // select mode (bulk assign)
  const [selected, setSelected] = useState<SlotRef[]>([]);
  const [bulkForm, setBulkForm] = useState({ subjectId: "", facultyId: "", overwrite: false });

  // swap mode
  const [swapPair, setSwapPair] = useState<SlotRef[]>([]);

  // one-off date override
  const [overrideDate, setOverrideDate] = useState(toDateInput(new Date()));
  const [overrideForm, setOverrideForm] = useState({
    hourNumber: 1,
    subjectId: "",
    facultyId: "",
    reason: "",
    cancel: false,
    // Attendance is still taken (so bunk detection still catches a skip) but the
    // hour is excluded from the percentage — distinct from `cancel`, which takes
    // no attendance at all.
    trackButNotCount: false,
  });

  const entries = useQuery({
    queryKey: ["timetable", sectionId],
    queryFn: () => timetableApi.list(token!, { sectionId }),
    enabled: !!token && !!sectionId,
  });
  const subjects = useQuery({ queryKey: ["subjects"], queryFn: () => subjectApi.list(token!), enabled: !!token });
  const faculty = useQuery({ queryKey: ["faculty"], queryFn: () => facultyApi.list(token!), enabled: !!token });
  const overrides = useQuery({
    queryKey: ["overrides", sectionId, overrideDate],
    queryFn: () => timetableOverrideApi.list(token!, { sectionId, dateFrom: overrideDate, dateTo: overrideDate }),
    enabled: !!token && !!sectionId && !!overrideDate,
  });

  // A block occupies every hour it spans, so map each covered cell back to its entry;
  // only the starting cell renders it, the rest are drawn as continuations.
  const bySlot = new Map<string, { entry: TimetableEntry; isStart: boolean }>();
  for (const e of entries.data ?? []) {
    for (let i = 0; i < (e.durationHours ?? 1); i++) {
      bySlot.set(`${e.dayOfWeek}-${e.hourNumber + i}`, { entry: e, isStart: i === 0 });
    }
  }

  // Faculty isn't stored on Subject — the mapping lives in the timetable, so the
  // subject's usual teacher for this section is whoever already teaches it here.
  // Used to prefill the faculty select whenever a subject is picked; still overridable.
  const facultyForSubject = new Map<string, string>();
  for (const e of entries.data ?? []) {
    if (!facultyForSubject.has(e.subjectId)) facultyForSubject.set(e.subjectId, e.facultyId);
  }

  function onError(err: unknown) {
    setNotice(null);
    setError(err instanceof ApiError ? err.message : "Request failed");
  }
  function succeed(message: string) {
    setError(null);
    setNotice(message);
    qc.invalidateQueries({ queryKey: ["timetable"] });
    qc.invalidateQueries({ queryKey: ["overrides"] });
  }

  const create = useMutation({
    mutationFn: () =>
      timetableApi.create(token!, {
        semesterId,
        sectionId,
        dayOfWeek: slot!.dayOfWeek,
        hourNumber: slot!.hourNumber,
        durationHours: form.durationHours,
        subjectId: form.subjectId,
        facultyId: form.facultyId,
      }),
    onSuccess: () => {
      setSlot(null);
      setForm({ subjectId: "", facultyId: "", durationHours: 1 });
      succeed("Slot assigned.");
    },
    onError,
  });

  const update = useMutation({
    mutationFn: (id: string) =>
      timetableApi.update(token!, id, {
        subjectId: form.subjectId,
        facultyId: form.facultyId,
        durationHours: form.durationHours,
      }),
    onSuccess: () => {
      setSlot(null);
      succeed("Slot updated.");
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: (id: string) => timetableApi.remove(token!, id),
    onSuccess: () => {
      setSlot(null);
      succeed("Slot cleared.");
    },
    onError,
  });

  const bulkAssign = useMutation({
    mutationFn: () =>
      timetableApi.bulkAssign(token!, {
        semesterId,
        sectionId,
        subjectId: bulkForm.subjectId,
        facultyId: bulkForm.facultyId,
        slots: selected,
        overwrite: bulkForm.overwrite,
      }),
    onSuccess: (res) => {
      if (res.assigned) {
        setSelected([]);
        succeed(`Assigned to ${res.count} slot${res.count === 1 ? "" : "s"}.`);
      } else {
        // 422: nothing was written, so list every clashing slot for fixing.
        setNotice(null);
        setError(
          res.errors.map((e) => `${DAY_SHORT[e.dayOfWeek]} H${e.hourNumber}: ${e.message}`).join(" · ")
        );
      }
    },
    onError,
  });

  const swap = useMutation({
    mutationFn: () =>
      timetableApi.swap(token!, { sectionId, a: swapPair[0], b: swapPair[1] }),
    onSuccess: (res) => {
      setSwapPair([]);
      succeed(res.moved === 2 ? "Periods swapped." : "Period moved.");
    },
    onError,
  });

  const setOverride = useMutation({
    mutationFn: () =>
      timetableOverrideApi.set(token!, {
        semesterId,
        sectionId,
        date: overrideDate,
        hourNumber: overrideForm.hourNumber,
        subjectId: overrideForm.cancel ? null : overrideForm.subjectId,
        facultyId: overrideForm.cancel ? null : overrideForm.facultyId,
        reason: overrideForm.reason || undefined,
        countsForAttendance: overrideForm.cancel ? undefined : !overrideForm.trackButNotCount,
      }),
    onSuccess: () => {
      setOverrideForm({
        hourNumber: 1,
        subjectId: "",
        facultyId: "",
        reason: "",
        cancel: false,
        trackButNotCount: false,
      });
      succeed("Override saved for that date.");
    },
    onError,
  });

  const removeOverride = useMutation({
    mutationFn: (id: string) => timetableOverrideApi.remove(token!, id),
    onSuccess: () => succeed("Override removed — that date follows the weekly timetable again."),
    onError,
  });

  const activeEntry = slot ? bySlot.get(slotKey(slot))?.entry : undefined;

  /** One click handler for the grid; what it does depends on the active mode. */
  function onCellClick(day: number, hour: number) {
    const cell = bySlot.get(`${day}-${hour}`);
    setError(null);

    if (mode === "edit") {
      const start = cell ? { dayOfWeek: day, hourNumber: cell.entry.hourNumber } : { dayOfWeek: day, hourNumber: hour };
      setSlot(start);
      setForm({
        subjectId: cell?.entry.subjectId ?? "",
        facultyId: cell?.entry.facultyId ?? "",
        durationHours: cell?.entry.durationHours ?? 1,
      });
      return;
    }

    if (mode === "select") {
      const key = `${day}-${hour}`;
      setSelected((prev) =>
        prev.some((s) => slotKey(s) === key)
          ? prev.filter((s) => slotKey(s) !== key)
          : [...prev, { dayOfWeek: day, hourNumber: hour }]
      );
      return;
    }

    // swap: collect exactly two slots, second click on the same slot deselects it
    const key = `${day}-${hour}`;
    setSwapPair((prev) => {
      if (prev.some((s) => slotKey(s) === key)) return prev.filter((s) => slotKey(s) !== key);
      if (prev.length >= 2) return [{ dayOfWeek: day, hourNumber: hour }];
      return [...prev, { dayOfWeek: day, hourNumber: hour }];
    });
  }

  function switchMode(next: Mode) {
    setMode(next);
    setSlot(null);
    setSelected([]);
    setSwapPair([]);
    setError(null);
    setNotice(null);
  }

  const isSelectedCell = (day: number, hour: number) =>
    selected.some((s) => s.dayOfWeek === day && s.hourNumber === hour);
  const swapIndexOf = (day: number, hour: number) =>
    swapPair.findIndex((s) => s.dayOfWeek === day && s.hourNumber === hour);

  const MODES: { key: Mode; label: string; hint: string }[] = [
    { key: "edit", label: "Edit slot", hint: "Tap a period to assign or change it" },
    { key: "select", label: "Multi-select", hint: "Tap several periods, then assign one subject to all of them" },
    { key: "swap", label: "Swap", hint: "Tap two periods to exchange them" },
  ];

  return (
    <AppShell>
      <PageHeader
        title="Timetable"
        subtitle="Weekly schedule, bulk assignment, swaps and one-off date changes"
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
        {notice && <Alert tone="green">{notice}</Alert>}

        <Card>
          <Field label="Section">
            <Select
              value={sectionId}
              onChange={(e) => {
                setSectionId(e.target.value);
                switchMode(mode);
              }}
            >
              <option value="">Select a section…</option>
              {sections.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  Section {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </Card>

        {!sectionId ? (
          <Card>
            <EmptyState message="Pick a section to view its timetable." />
          </Card>
        ) : entries.isLoading ? (
          <Card>
            <Spinner />
          </Card>
        ) : (
          <>
            <Card>
              <div className="flex flex-wrap gap-2">
                {MODES.map((m) => (
                  <button
                    key={m.key}
                    onClick={() => switchMode(m.key)}
                    className={cn(
                      "min-h-[40px] rounded-full px-4 text-sm",
                      mode === m.key ? "bg-slate-900 text-white" : "border bg-white text-slate-600"
                    )}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-500">{MODES.find((m) => m.key === mode)?.hint}</p>
            </Card>

            <Card>
              <CardTitle>Weekly grid</CardTitle>
              {/* Wide grid scrolls horizontally rather than squashing on phones. */}
              <div className="-mx-4 mt-3 overflow-x-auto px-4">
                <table className="w-full min-w-[560px] border-collapse text-xs">
                  <thead>
                    <tr>
                      <th className="w-12 border p-1 text-slate-500">Hr</th>
                      {WEEKDAYS.map((d) => (
                        <th key={d} className="border p-1 font-medium text-slate-600">
                          {DAY_SHORT[d]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {HOURS.map((hour) => (
                      <tr key={hour}>
                        <td className="border p-1 text-center text-slate-500">{hour}</td>
                        {WEEKDAYS.map((day) => {
                          const cell = bySlot.get(`${day}-${hour}`);
                          const entry = cell?.entry;
                          const picked = isSelectedCell(day, hour);
                          const swapIdx = swapIndexOf(day, hour);
                          const isActive =
                            mode === "edit" && slot?.dayOfWeek === day && entry
                              ? slot.hourNumber === entry.hourNumber
                              : mode === "edit" && slot?.dayOfWeek === day && slot?.hourNumber === hour;

                          if (cell && !cell.isStart) {
                            return (
                              <td key={day} className="border-x bg-slate-50 p-0">
                                <button
                                  onClick={() => onCellClick(day, hour)}
                                  className={cn(
                                    "h-14 w-full px-1 text-left align-top text-[10px] text-slate-400",
                                    picked && "bg-blue-100",
                                    swapIdx >= 0 && "bg-amber-100"
                                  )}
                                >
                                  ↑ cont.
                                </button>
                              </td>
                            );
                          }

                          return (
                            <td key={day} className="border p-0">
                              <button
                                onClick={() => onCellClick(day, hour)}
                                className={cn(
                                  "relative h-14 w-full px-1 text-left align-top leading-tight",
                                  entry ? "bg-slate-50" : "bg-white",
                                  picked && "bg-blue-100 ring-2 ring-inset ring-blue-500",
                                  swapIdx >= 0 && "bg-amber-100 ring-2 ring-inset ring-amber-500",
                                  isActive && "ring-2 ring-inset ring-slate-900"
                                )}
                              >
                                {swapIdx >= 0 && (
                                  <span className="absolute right-1 top-0.5 text-[9px] font-bold text-amber-700">
                                    {swapIdx + 1}
                                  </span>
                                )}
                                {entry ? (
                                  <>
                                    <span className="block truncate font-medium">
                                      {entry.subject?.code ?? "—"}
                                      {(entry.durationHours ?? 1) > 1 && (
                                        <span className="ml-1 text-[9px] text-slate-500">×{entry.durationHours}</span>
                                      )}
                                    </span>
                                    <span className="block truncate text-[10px] text-slate-500">
                                      {entry.faculty?.name}
                                    </span>
                                  </>
                                ) : (
                                  <span className="text-slate-300">+</span>
                                )}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            {mode === "edit" && slot && (
              <Card>
                <CardTitle>
                  {DAY_NAMES[slot.dayOfWeek]} · Hour {slot.hourNumber}
                </CardTitle>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <Field label="Subject">
                    <Select
                      value={form.subjectId}
                      onChange={(e) => {
                        const subjectId = e.target.value;
                        setForm({
                          ...form,
                          subjectId,
                          // Prefill this subject's usual teacher; the select stays editable.
                          facultyId: facultyForSubject.get(subjectId) ?? form.facultyId,
                        });
                      }}
                    >
                      <option value="">Select…</option>
                      {subjects.data?.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.code} — {s.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Faculty">
                    <Select value={form.facultyId} onChange={(e) => setForm({ ...form, facultyId: e.target.value })}>
                      <option value="">Select…</option>
                      {faculty.data?.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Duration">
                    <Select
                      value={form.durationHours}
                      onChange={(e) => setForm({ ...form, durationHours: Number(e.target.value) })}
                    >
                      {[1, 2, 3, 4].map((d) => (
                        <option key={d} value={d}>
                          {d} hour{d > 1 ? "s" : ""}
                          {d > 1 ? " (marked once)" : ""}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                {form.durationHours > 1 && (
                  <p className="mt-2 text-xs text-slate-500">
                    Occupies hours {slot.hourNumber}–{slot.hourNumber + form.durationHours - 1}. Attendance is taken
                    once and counts as {form.durationHours} hours.
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    onClick={() => (activeEntry ? update.mutate(activeEntry.id) : create.mutate())}
                    disabled={!form.subjectId || !form.facultyId || create.isPending || update.isPending}
                  >
                    {create.isPending || update.isPending ? "Saving…" : activeEntry ? "Update" : "Assign"}
                  </Button>
                  {activeEntry && (
                    <Button variant="danger" onClick={() => remove.mutate(activeEntry.id)}>
                      Clear slot
                    </Button>
                  )}
                  <Button variant="secondary" onClick={() => setSlot(null)}>
                    Close
                  </Button>
                </div>
              </Card>
            )}

            {mode === "select" && (
              <Card>
                <CardTitle>Assign to {selected.length} selected period{selected.length === 1 ? "" : "s"}</CardTitle>
                {!selected.length ? (
                  <EmptyState message="Tap periods in the grid to select them." />
                ) : (
                  <>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {selected.map((s) => (
                        <Badge key={slotKey(s)} tone="blue">
                          {DAY_SHORT[s.dayOfWeek]} H{s.hourNumber}
                        </Badge>
                      ))}
                    </div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <Field label="Subject">
                        <Select
                          value={bulkForm.subjectId}
                          onChange={(e) => {
                            const subjectId = e.target.value;
                            setBulkForm({
                              ...bulkForm,
                              subjectId,
                              facultyId: facultyForSubject.get(subjectId) ?? bulkForm.facultyId,
                            });
                          }}
                        >
                          <option value="">Select…</option>
                          {subjects.data?.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.code} — {s.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Faculty">
                        <Select
                          value={bulkForm.facultyId}
                          onChange={(e) => setBulkForm({ ...bulkForm, facultyId: e.target.value })}
                        >
                          <option value="">Select…</option>
                          {faculty.data?.map((f) => (
                            <option key={f.id} value={f.id}>
                              {f.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </div>
                    <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={bulkForm.overwrite}
                        onChange={(e) => setBulkForm({ ...bulkForm, overwrite: e.target.checked })}
                        className="h-4 w-4"
                      />
                      Replace whatever already occupies those periods
                    </label>
                    <p className="mt-2 text-xs text-slate-500">
                      Each period becomes its own 1-hour entry, marked separately.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        onClick={() => bulkAssign.mutate()}
                        disabled={!bulkForm.subjectId || !bulkForm.facultyId || bulkAssign.isPending}
                      >
                        {bulkAssign.isPending ? "Assigning…" : `Assign to ${selected.length}`}
                      </Button>
                      <Button variant="secondary" onClick={() => setSelected([])}>
                        Clear selection
                      </Button>
                    </div>
                  </>
                )}
              </Card>
            )}

            {mode === "swap" && (
              <Card>
                <CardTitle>Swap periods</CardTitle>
                {swapPair.length < 2 ? (
                  <p className="mt-2 text-sm text-slate-500">
                    {swapPair.length === 0
                      ? "Tap the first period to swap."
                      : `Selected ${DAY_SHORT[swapPair[0].dayOfWeek]} H${swapPair[0].hourNumber} — now tap the second.`}
                  </p>
                ) : (
                  <>
                    <p className="mt-2 text-sm text-slate-700">
                      Swap <strong>{DAY_SHORT[swapPair[0].dayOfWeek]} H{swapPair[0].hourNumber}</strong> with{" "}
                      <strong>{DAY_SHORT[swapPair[1].dayOfWeek]} H{swapPair[1].hourNumber}</strong>?
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      If one period is empty the other simply moves into it.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button onClick={() => swap.mutate()} disabled={swap.isPending}>
                        {swap.isPending ? "Swapping…" : "Confirm swap"}
                      </Button>
                      <Button variant="secondary" onClick={() => setSwapPair([])}>
                        Reset
                      </Button>
                    </div>
                  </>
                )}
              </Card>
            )}

            <Card>
              <CardTitle>One-off change for a specific date</CardTitle>
              <p className="mt-1 text-xs text-slate-500">
                Changes a single date only — the weekly timetable above stays untouched. Picking a subject fills in its
                usual faculty, which you can still change.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Date">
                  <Input type="date" value={overrideDate} onChange={(e) => setOverrideDate(e.target.value)} />
                </Field>
                <Field label="Hour">
                  <Select
                    value={overrideForm.hourNumber}
                    onChange={(e) => setOverrideForm({ ...overrideForm, hourNumber: Number(e.target.value) })}
                  >
                    {HOURS.map((h) => (
                      <option key={h} value={h}>
                        Hour {h}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Subject">
                  <Select
                    value={overrideForm.subjectId}
                    disabled={overrideForm.cancel}
                    onChange={(e) => {
                      const subjectId = e.target.value;
                      setOverrideForm({
                        ...overrideForm,
                        subjectId,
                        facultyId: facultyForSubject.get(subjectId) ?? overrideForm.facultyId,
                      });
                    }}
                  >
                    <option value="">Select…</option>
                    {subjects.data?.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.code} — {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Faculty">
                  <Select
                    value={overrideForm.facultyId}
                    disabled={overrideForm.cancel}
                    onChange={(e) => setOverrideForm({ ...overrideForm, facultyId: e.target.value })}
                  >
                    <option value="">Select…</option>
                    {faculty.data?.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="Reason (optional)">
                  <Input
                    value={overrideForm.reason}
                    onChange={(e) => setOverrideForm({ ...overrideForm, reason: e.target.value })}
                    placeholder="e.g. Faculty on leave"
                  />
                </Field>
                <div className="flex flex-col justify-end gap-2 pb-1">
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={overrideForm.cancel}
                      onChange={(e) => setOverrideForm({ ...overrideForm, cancel: e.target.checked })}
                      className="h-4 w-4"
                    />
                    Cancel this period instead (no attendance)
                  </label>
                  <label
                    className={cn(
                      "flex items-center gap-2 text-sm",
                      overrideForm.cancel ? "text-slate-400" : "text-slate-700"
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={overrideForm.trackButNotCount}
                      disabled={overrideForm.cancel}
                      onChange={(e) => setOverrideForm({ ...overrideForm, trackButNotCount: e.target.checked })}
                      className="h-4 w-4"
                    />
                    Attendance is taken, but doesn't count — still tracked to catch bunkers
                  </label>
                </div>
              </div>
              <Button
                onClick={() => setOverride.mutate()}
                disabled={
                  (!overrideForm.cancel && (!overrideForm.subjectId || !overrideForm.facultyId)) || setOverride.isPending
                }
                className="mt-3 w-full sm:w-auto"
              >
                {setOverride.isPending ? "Saving…" : "Save override"}
              </Button>

              {overrides.data && overrides.data.length > 0 && (
                <div className="mt-4">
                  <p className="text-sm font-medium text-slate-700">Overrides on {overrideDate}</p>
                  <ul className="mt-2 divide-y border-t">
                    {overrides.data.map((o) => (
                      <li key={o.id} className="flex items-center justify-between gap-3 py-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm">
                            <span className="text-slate-500">H{o.hourNumber}</span>{" "}
                            {o.subject ? `${o.subject.code} — ${o.subject.name}` : "Cancelled"}
                            {o.faculty ? ` · ${o.faculty.name}` : ""}
                          </p>
                          {o.subject && o.countsForAttendance === false && (
                            <Badge tone="amber">Tracked, not counted</Badge>
                          )}
                          {o.reason && <p className="text-xs italic text-slate-500">{o.reason}</p>}
                        </div>
                        <button onClick={() => removeOverride.mutate(o.id)} className="shrink-0 text-sm text-red-600">
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
