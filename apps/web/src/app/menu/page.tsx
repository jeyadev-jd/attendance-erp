"use client";

import Link from "next/link";
import { AppShell, navFor } from "@/components/AppShell";
import { PageHeader, Card } from "@/components/ui";
import { useClaims } from "@/store/authStore";

/** Mobile-only overflow menu: the bottom bar shows four items, everything else lands here. */
export default function MenuPage() {
  const claims = useClaims();
  const nav = navFor(claims?.role);

  return (
    <AppShell>
      <PageHeader title="Menu" subtitle="All sections" />
      <Card className="p-0">
        <ul className="divide-y">
          {nav.map((item) => (
            <li key={item.href}>
              <Link href={item.href} className="flex min-h-[52px] items-center px-4 text-sm text-slate-700">
                {item.label}
              </Link>
            </li>
          ))}
          <li>
            <Link href="/notifications" className="flex min-h-[52px] items-center px-4 text-sm text-slate-700">
              Notifications
            </Link>
          </li>
        </ul>
      </Card>
    </AppShell>
  );
}
