"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { PageHeader, Card, CardTitle, Input, Field, Badge, Button, Spinner, EmptyState, TableScroll } from "@/components/ui";
import { studentApi } from "@/lib/api";
import { useToken } from "@/lib/hooks";

/** Formats an ISO date as e.g. "Mon, 14 Sep" — short enough for a table cell. */
function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export default function CalculatorsPage() {
  const token = useToken();
  const [targetInput, setTargetInput] = useState(80);
  const [target, setTarget] = useState(80);
  const [selectedId, setSelectedId] = useState<string>("");
  const [n, setN] = useState(3);

  const planner = useQuery({
    queryKey: ["subject-planner", target],
    queryFn: () => studentApi.subjectPlanner(token!, target),
    enabled: !!token,
  });

  const subjects = planner.data?.subjects ?? [];

  // Default to the subject most at risk — it sorts first, so it's the one worth planning around.
  useEffect(() => {
    if (!selectedId && subjects.length) setSelectedId(subjects[0].subjectId);
  }, [subjects, selectedId]);

  const selected = subjects.find((s) => s.subjectId === selectedId);

  const sim = useMutation({
    mutationFn: () => studentApi.simulateBunk(token!, { subjectId: selectedId || undefined, n }),
  });

  return (
    <AppShell>
      <PageHeader title="Attendance planner" subtitle="Subject-wise standing, safe bunks, recovery and projected dates" />

      {planner.isLoading ? (
        <Card>
          <Spinner />
        </Card>
      ) : (
        <div className="space-y-4">
          <Card>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-32">
                <Field label="Target %">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={targetInput}
                    onChange={(e) => setTargetInput(Number(e.target.value))}
                  />
                </Field>
              </div>
              <Button onClick={() => setTarget(targetInput)} disabled={targetInput === target}>
                Apply target
              </Button>
              <p className="pb-2 text-xs text-slate-500">
                Projections run to the end of the semester ({planner.data?.semesterEndDate}), skipping holidays.
              </p>
            </div>
          </Card>

          <Card>
            <CardTitle>Subject-wise plan</CardTitle>
            <p className="mt-1 text-xs text-slate-500">
              Tap a subject to simulate it below. Dates are projected from your real timetable.
            </p>
            {!subjects.length ? (
              <EmptyState message="No subjects in your timetable yet." />
            ) : (
              <TableScroll>
                <table className="mt-3 w-full min-w-[720px] text-left text-sm">
                  <thead>
                    <tr className="border-b text-xs text-slate-500">
                      <th className="py-2 pr-3 font-medium">Subject</th>
                      <th className="py-2 pr-3 font-medium">Attended</th>
                      <th className="py-2 pr-3 font-medium">Current</th>
                      <th className="py-2 pr-3 font-medium">Can skip</th>
                      <th className="py-2 pr-3 font-medium">Need to attend</th>
                      <th className="py-2 pr-3 font-medium">Left</th>
                      <th className="py-2 font-medium">Projection</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subjects.map((s) => (
                      <tr
                        key={s.subjectId}
                        onClick={() => setSelectedId(s.subjectId)}
                        className={`cursor-pointer border-b last:border-0 ${
                          s.subjectId === selectedId ? "bg-slate-50" : ""
                        }`}
                      >
                        <td className="py-2 pr-3">
                          <div className="font-medium">{s.name}</div>
                          <div className="text-xs text-slate-500">{s.code}</div>
                        </td>
                        <td className="py-2 pr-3 text-slate-600">
                          {s.present}/{s.total}
                        </td>
                        <td className="py-2 pr-3">
                          {s.total === 0 ? (
                            <span className="text-slate-400">—</span>
                          ) : (
                            <Badge tone={s.onTrack ? "green" : "red"}>{s.currentPct.toFixed(0)}%</Badge>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-slate-600">{s.onTrack ? s.safeBunkHours : "—"}</td>
                        <td className="py-2 pr-3 text-slate-600">{s.onTrack ? "—" : s.recoveryHours}</td>
                        <td className="py-2 pr-3 text-slate-600">{s.remainingClasses}</td>
                        <td className="py-2 text-xs">
                          {s.total === 0 ? (
                            <span className="text-slate-400">No classes marked yet</span>
                          ) : s.onTrack ? (
                            s.fallBelowOn ? (
                              <span className="text-red-600">
                                Drops below {s.targetPct}% on <strong>{shortDate(s.fallBelowOn.date)}</strong> if you
                                skip everything ({s.fallBelowOn.afterClasses} classes)
                              </span>
                            ) : (
                              <span className="text-emerald-600">Stays above {s.targetPct}% all semester</span>
                            )
                          ) : s.recoverOn ? (
                            <span className="text-emerald-600">
                              Back to {s.targetPct}% on <strong>{shortDate(s.recoverOn.date)}</strong> if you attend
                              everything ({s.recoverOn.afterClasses} classes)
                            </span>
                          ) : (
                            <span className="text-red-600">
                              Cannot reach {s.targetPct}% before the semester ends
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </Card>

          {selected && (
            <Card>
              <CardTitle>What if I bunk — {selected.name}</CardTitle>
              <div className="mt-3 flex flex-wrap items-end gap-4">
                <div className="w-32">
                  <Field label="Skip N classes">
                    <Input type="number" min={0} value={n} onChange={(e) => setN(Number(e.target.value))} />
                  </Field>
                </div>
                <Button onClick={() => sim.mutate()} disabled={sim.isPending}>
                  {sim.isPending ? "Running…" : "Run"}
                </Button>
              </div>

              {sim.data && (
                <div className="mt-4 rounded-lg bg-slate-50 p-4">
                  <p className="text-sm text-slate-500">
                    Skipping {sim.data.additionalAbsences} more class
                    {sim.data.additionalAbsences === 1 ? "" : "es"} of this subject:
                  </p>
                  <p
                    className={`mt-1 text-3xl font-bold ${
                      sim.data.simulatedPct < target ? "text-red-600" : "text-emerald-600"
                    }`}
                  >
                    {sim.data.simulatedPct.toFixed(1)}%
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Down from {sim.data.currentPct.toFixed(1)}% now.
                  </p>
                </div>
              )}
            </Card>
          )}
        </div>
      )}
    </AppShell>
  );
}
