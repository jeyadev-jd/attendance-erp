"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore, useClaims, isAdminRole, type Role } from "@/store/authStore";
import { notificationApi } from "@/lib/api";
import { cn } from "./ui";

type NavItem = {
  href: string;
  label: string;
  short: string;
  roles: "admin" | "student" | "all";
  /** Also shown to FACULTY. Everything without this is admin-only. */
  faculty?: boolean;
};

// Mobile shows only the first four `primary` items in the bottom bar; the rest
// live in the "More" sheet on mobile and the full sidebar on desktop.
const ADMIN_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", short: "Home", roles: "admin", faculty: true },
  { href: "/attendance/mark", label: "Mark Attendance", short: "Mark", roles: "admin" },
  { href: "/admin/analytics", label: "Analytics", short: "Stats", roles: "admin", faculty: true },
  { href: "/admin/students", label: "Students", short: "Students", roles: "admin", faculty: true },
  // Class admins are students in their own batch, so they get the student portal too.
  { href: "/student/dashboard", label: "My Attendance", short: "Mine", roles: "admin" },
  { href: "/student/calculators", label: "My Bunk Calculator", short: "Calc", roles: "admin" },
  { href: "/admin/users", label: "Admins & Staff", short: "Staff", roles: "admin" },
  { href: "/admin/timetable", label: "Timetable", short: "Timetable", roles: "admin" },
  { href: "/admin/calendar", label: "Calendar", short: "Calendar", roles: "admin" },
  { href: "/admin/structure", label: "Departments & Sections", short: "Structure", roles: "admin" },
  { href: "/admin/semesters", label: "Semesters", short: "Semesters", roles: "admin" },
  { href: "/admin/hour-config", label: "Hour Config", short: "Hours", roles: "admin" },
  { href: "/admin/reports", label: "Reports", short: "Reports", roles: "admin", faculty: true },
  { href: "/admin/audit-logs", label: "Audit Logs", short: "Audit", roles: "admin" },
  { href: "/admin/settings", label: "Settings", short: "Settings", roles: "admin" },
];

const STUDENT_NAV: NavItem[] = [
  { href: "/student/dashboard", label: "Dashboard", short: "Home", roles: "student" },
  { href: "/student/timeline", label: "Timeline", short: "Timeline", roles: "student" },
  { href: "/student/analytics", label: "My Analytics", short: "Stats", roles: "student" },
  { href: "/student/calculators", label: "Calculators", short: "Calc", roles: "student" },
];

export function navFor(role: Role | undefined | null): NavItem[] {
  if (isAdminRole(role)) return ADMIN_NAV;
  // Faculty read attendance but do not administer it, so they get the items marked
  // `faculty` and nothing else. Flagging the four they can use beats listing the
  // dozen they cannot — a new admin page is hidden by default rather than by
  // remembering to add it to a blocklist.
  if (role === "FACULTY") return ADMIN_NAV.filter((i) => i.faculty);
  return STUDENT_NAV;
}

export function homeFor(role: Role | undefined | null): string {
  return isAdminRole(role) || role === "FACULTY" ? "/dashboard" : "/student/dashboard";
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const token = useAuthStore((s) => s.token);
  const logout = useAuthStore((s) => s.logout);
  const hasHydrated = useAuthStore((s) => s.hasHydrated);
  const claims = useClaims();

  useEffect(() => {
    // Wait for the persisted token to load from localStorage before deciding to bounce —
    // otherwise every hard navigation/reload redirects a signed-in user to /login for
    // one frame while `token` is still its pre-hydration `null`.
    if (hasHydrated && !token) router.replace("/login");
  }, [hasHydrated, token, router]);

  const { data: unread } = useQuery({
    queryKey: ["notifications", "unread"],
    queryFn: () => notificationApi.unreadCount(token!),
    enabled: !!token,
    refetchInterval: 60_000,
  });

  if (!token) return null;

  const nav = navFor(claims?.role);
  const primary = nav.slice(0, 4);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r bg-white lg:flex">
        <div className="border-b px-5 py-4">
          <p className="text-sm font-semibold text-slate-900">Attendance ERP</p>
          <p className="mt-0.5 text-xs text-slate-500">{claims?.role.replace("_", " ")}</p>
        </div>
        <nav className="flex-1 overflow-y-auto p-3">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "block rounded-md px-3 py-2 text-sm",
                pathname === item.href ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="border-t p-3">
          <button
            onClick={() => {
              logout();
              router.replace("/login");
            }}
            className="w-full rounded-md px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-100"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 flex items-center justify-between border-b bg-white px-4 py-3 lg:hidden">
        <p className="text-sm font-semibold">Attendance ERP</p>
        <div className="flex items-center gap-3">
          <Link href="/notifications" className="relative text-sm text-slate-600">
            Alerts
            {!!unread?.count && (
              <span className="absolute -right-2 -top-1 rounded-full bg-red-600 px-1.5 text-[10px] font-medium text-white">
                {unread.count}
              </span>
            )}
          </Link>
          <button
            onClick={() => {
              logout();
              router.replace("/login");
            }}
            className="text-sm text-slate-600"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* pb-24 leaves room for the fixed bottom nav on mobile. */}
      <main className="px-4 pb-24 pt-4 sm:px-6 lg:ml-60 lg:pb-10">{children}</main>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t bg-white lg:hidden">
        {primary.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex min-h-[56px] flex-col items-center justify-center px-1 text-[11px]",
              pathname === item.href ? "font-semibold text-slate-900" : "text-slate-500"
            )}
          >
            {item.short}
          </Link>
        ))}
        <Link
          href="/menu"
          className={cn(
            "flex min-h-[56px] flex-col items-center justify-center text-[11px]",
            pathname === "/menu" ? "font-semibold text-slate-900" : "text-slate-500"
          )}
        >
          More
        </Link>
      </nav>
    </div>
  );
}
