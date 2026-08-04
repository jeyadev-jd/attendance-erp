// Falls back to the spec's documented defaults when an organization hasn't configured Settings yet.
const DEFAULTS = {
  minAttendancePct: 80,
  gracePeriodMinutes: 5,
  lateThresholdMinutes: 15,
  veryLateThresholdMinutes: 30,
  editWindowHours: 24,
  autoLockAfterDays: 3,
};

export async function getSettings(prisma: any, organizationId: string) {
  const settings = await prisma.settings.findUnique({ where: { organizationId } });
  return settings ?? { organizationId, ...DEFAULTS };
}
