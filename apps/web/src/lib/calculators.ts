// Mirrors apps/api/src/lib/calculators.ts — kept client-side so the calculator
// page works instantly on any hypothetical present/total without a round trip.
export function attendancePct(present: number, total: number): number {
  if (total === 0) return 0;
  return (present / total) * 100;
}

export function safeBunkHours(present: number, total: number, minPct: number): number {
  const ratio = minPct / 100;
  if (ratio === 0) return 0;
  return Math.max(0, Math.floor((present - ratio * total) / ratio));
}

export function recoveryHours(present: number, total: number, minPct: number): number {
  const ratio = minPct / 100;
  if (ratio >= 1) return 0;
  return Math.max(0, Math.ceil((ratio * total - present) / (1 - ratio)));
}

export function bunkSimulator(present: number, total: number, n: number): number {
  if (total + n === 0) return 0;
  return (present / (total + n)) * 100;
}
