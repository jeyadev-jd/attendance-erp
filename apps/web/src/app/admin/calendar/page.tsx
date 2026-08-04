"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { PageHeader, Card, CardTitle, Button, Input, Select, Field, Alert, Spinner, Badge, cn } from "@/components/ui";
import { calendarApi, ApiError, type DayType, type CalendarDay } from "@/lib/api";
import { useSemesters, useToken, DAY_SHORT } from "@/lib/hooks";

const DAY_TYPES: DayType[] = [
  "WORKING",
  "HOLIDAY",
  "EXAM",
  "INTERNAL_EXAM",
  "EVENT",
  "WORKSHOP",
  "INDUSTRIAL_VISIT",
  "SPORTS_DAY",
  "SYMPOSIUM",
  "STUDY_HOLIDAY",
  "CUSTOM",
];

// Only WORKING days allow marking; everything else is visually de-emphasised.
const TYPE_COLOR: Record<DayType, string> = {
  WORKING: "bg-white",
  HOLIDAY: "bg-red-100 text-red-800",
  EXAM: "bg-purple-100 text-purple-800",
  INTERNAL_EXAM: "bg-purple-50 text-purple-700",
  EVENT: "bg-blue-100 text-blue-800",
  WORKSHOP: "bg-amber-100 text-amber-800",
  INDUSTRIAL_VISIT: "bg-teal-100 text-teal-800",
  SPORTS_DAY: "bg-lime-100 text-lime-800",
  SYMPOSIUM: "bg-indigo-100 text-indigo-800",
  STUDY_HOLIDAY: "bg-orange-100 text-orange-800",
  CUSTOM: "bg-slate-100 text-slate-700",
};

export default function CalendarPage() {
  const token = useToken();
  const qc = useQueryClient();
  const { semesters, semesterId, setSemesterId } = useSemesters();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bulk, setBulk] = useState({ startDate: "", endDate: "", dayType: "HOLIDAY" as DayType, label: "" });

  const days = useQuery({
    queryKey: ["calendar", semesterId, year, month],
    queryFn: () => calendarApi.month(token!, semesterId, year, month),
    enabled: !!token && !!semesterId,
  });

  const byDate = new Map((days.data ?? []).map((d) => [d.date.slice(0, 10), d]));

  // A date with no calendar row yet is an implicit WORKING day — represent it so the
  // detail panel can open on any date, saved or not.
  const selected: CalendarDay | null = selectedDate
    ? byDate.get(selectedDate) ?? {
        id: "",
        date: selectedDate,
        dayType: "WORKING",
        label: null,
        notes: null,
        hourOverrides: [],
      }
    : null;

  function onError(err: unknown) {
    setError(err instanceof ApiError ? err.message : "Request failed");
  }
  function invalidate() {
    setError(null);
    qc.invalidateQueries({ queryKey: ["calendar"] });
  }

  const setDay = useMutation({
    mutationFn: (body: { date: string; dayType: DayType; label?: string }) =>
      calendarApi.setDay(token!, { semesterId, ...body }),
    // Track the date only; the panel re-reads the day from refetched month data below,
    // so it always renders the server's full shape rather than a mutation response.
    onSuccess: (day) => {
      invalidate();
      setSelectedDate(day.date.slice(0, 10));
    },
    onError,
  });

  const bulkRange = useMutation({
    mutationFn: () =>
      calendarApi.bulkRange(token!, {
        semesterId,
        startDate: bulk.startDate,
        endDate: bulk.endDate,
        dayType: bulk.dayType,
        label: bulk.label || undefined,
      }),
    onSuccess: () => {
      invalidate();
      setBulk({ startDate: "", endDate: "", dayType: "HOLIDAY", label: "" });
    },
    onError,
  });

  const toggleHour = useMutation({
    mutationFn: (v: { date: string; hourNumber: number; attendanceEnabled: boolean }) =>
      calendarApi.setHourOverride(token!, { semesterId, ...v }),
    onSuccess: () => invalidate(),
    onError,
  });

  // Leading blanks align the 1st onto the correct weekday column.
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells: (number | null)[] = [...Array(firstWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];

  function dateStr(day: number) {
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function shiftMonth(delta: number) {
    const d = new Date(year, month - 1 + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
    setSelectedDate(null);
  }

  return (
    <AppShell>
      <PageHeader
        title="Calendar"
        subtitle="Day types and per-hour attendance overrides"
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

        <Card>
          <div className="mb-3 flex items-center justify-between">
            <Button variant="secondary" onClick={() => shiftMonth(-1)} className="min-w-[44px] px-3">
              ‹
            </Button>
            <CardTitle>
              {new Date(year, month - 1).toLocaleString(undefined, { month: "long", year: "numeric" })}
            </CardTitle>
            <Button variant="secondary" onClick={() => shiftMonth(1)} className="min-w-[44px] px-3">
              ›
            </Button>
          </div>

          {days.isLoading ? (
            <Spinner />
          ) : (
            <>
              <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-slate-500">
                {DAY_SHORT.map((d) => (
                  <div key={d} className="py-1">
                    {d}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {cells.map((day, i) => {
                  if (day === null) return <div key={`blank-${i}`} />;
                  const entry = byDate.get(dateStr(day));
                  const type = entry?.dayType ?? "WORKING";
                  const disabledHours = entry?.hourOverrides?.filter((h) => !h.attendanceEnabled).length ?? 0;
                  return (
                    <button
                      key={day}
                      onClick={() => setSelectedDate(dateStr(day))}
                      className={cn(
                        "relative min-h-[44px] rounded-md border text-sm",
                        TYPE_COLOR[type],
                        selected?.date.slice(0, 10) === dateStr(day) && "ring-2 ring-slate-900"
                      )}
                    >
                      {day}
                      {disabledHours > 0 && (
                        <span className="absolute bottom-0.5 right-1 text-[9px] text-slate-600">{disabledHours}⃠</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </Card>

        {selected && (
          <Card>
            <CardTitle>{selected.date.slice(0, 10)}</CardTitle>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Day type">
                <Select
                  value={selected.dayType}
                  onChange={(e) =>
                    setDay.mutate({ date: selected.date.slice(0, 10), dayType: e.target.value as DayType, label: selected.label ?? undefined })
                  }
                >
                  {DAY_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.replace(/_/g, " ")}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Label">
                <Input
                  // Uncontrolled so typing isn't fought by refetches; keyed by date so
                  // switching days actually reloads the value.
                  key={selected.date.slice(0, 10)}
                  defaultValue={selected.label ?? ""}
                  placeholder="e.g. Diwali"
                  onBlur={(e) =>
                    setDay.mutate({ date: selected.date.slice(0, 10), dayType: selected.dayType, label: e.target.value })
                  }
                />
              </Field>
            </div>

            <div className="mt-4">
              <p className="text-sm font-medium text-slate-700">Hour overrides</p>
              <p className="mt-0.5 text-xs text-slate-500">
                Turn a specific hour off — e.g. hours 1–2 are an exam, 3–6 run as normal classes.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {Array.from({ length: 8 }, (_, i) => i + 1).map((hour) => {
                  const override = selected.hourOverrides?.find((h) => h.hourNumber === hour);
                  const enabled = override ? override.attendanceEnabled : true;
                  return (
                    <button
                      key={hour}
                      onClick={() =>
                        toggleHour.mutate({ date: selected.date.slice(0, 10), hourNumber: hour, attendanceEnabled: !enabled })
                      }
                      className={cn(
                        "min-h-[44px] min-w-[44px] rounded-md border px-3 text-sm",
                        enabled ? "bg-white text-slate-700" : "bg-red-100 text-red-700 line-through"
                      )}
                    >
                      H{hour}
                    </button>
                  );
                })}
              </div>
            </div>
          </Card>
        )}

        <Card>
          <CardTitle>Bulk set a date range</CardTitle>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <Field label="From">
              <Input type="date" value={bulk.startDate} onChange={(e) => setBulk({ ...bulk, startDate: e.target.value })} />
            </Field>
            <Field label="To">
              <Input type="date" value={bulk.endDate} onChange={(e) => setBulk({ ...bulk, endDate: e.target.value })} />
            </Field>
            <Field label="Day type">
              <Select value={bulk.dayType} onChange={(e) => setBulk({ ...bulk, dayType: e.target.value as DayType })}>
                {DAY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Label">
              <Input value={bulk.label} onChange={(e) => setBulk({ ...bulk, label: e.target.value })} />
            </Field>
          </div>
          <Button
            onClick={() => bulkRange.mutate()}
            disabled={!bulk.startDate || !bulk.endDate || bulkRange.isPending}
            className="mt-3 w-full sm:w-auto"
          >
            {bulkRange.isPending ? "Applying…" : "Apply to range"}
          </Button>
        </Card>

        <Card>
          <CardTitle>Legend</CardTitle>
          <div className="mt-2 flex flex-wrap gap-2">
            {DAY_TYPES.map((t) => (
              <span key={t} className={cn("rounded-md px-2 py-1 text-xs", TYPE_COLOR[t], t === "WORKING" && "border")}>
                {t.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
