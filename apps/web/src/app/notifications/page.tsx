"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { PageHeader, Card, Button, Spinner, EmptyState, Badge, cn } from "@/components/ui";
import { notificationApi } from "@/lib/api";
import { useToken } from "@/lib/hooks";

// Cron writes CRITICAL/WARNING alerts when a student crosses the attendance thresholds.
const TYPE_TONE: Record<string, "red" | "amber" | "blue" | "slate"> = {
  CRITICAL: "red",
  WARNING: "amber",
  INFO: "blue",
};

export default function NotificationsPage() {
  const token = useToken();
  const qc = useQueryClient();

  const list = useQuery({
    queryKey: ["notifications", "all"],
    queryFn: () => notificationApi.list(token!, { limit: 100 }),
    enabled: !!token,
  });

  function refresh() {
    qc.invalidateQueries({ queryKey: ["notifications"] });
  }

  const markRead = useMutation({ mutationFn: (id: string) => notificationApi.markRead(token!, id), onSuccess: refresh });
  const markAll = useMutation({ mutationFn: () => notificationApi.markAllRead(token!), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => notificationApi.remove(token!, id), onSuccess: refresh });

  const unread = list.data?.filter((n) => !n.isRead).length ?? 0;

  return (
    <AppShell>
      <PageHeader
        title="Notifications"
        subtitle={unread ? `${unread} unread` : "You're all caught up"}
        action={
          unread ? (
            <Button variant="secondary" onClick={() => markAll.mutate()} disabled={markAll.isPending}>
              Mark all read
            </Button>
          ) : null
        }
      />

      <Card className="p-0">
        {list.isLoading ? (
          <Spinner />
        ) : !list.data?.length ? (
          <EmptyState message="No notifications yet." />
        ) : (
          <ul className="divide-y">
            {list.data.map((n) => (
              <li key={n.id} className={cn("px-4 py-3", !n.isRead && "bg-blue-50/40")}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{n.title}</p>
                      <Badge tone={TYPE_TONE[n.type] ?? "slate"}>{n.type}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-slate-600">{n.message}</p>
                    <p className="mt-1 text-xs text-slate-400">{new Date(n.createdAt).toLocaleString()}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    {!n.isRead && (
                      <button onClick={() => markRead.mutate(n.id)} className="text-xs text-slate-600">
                        Mark read
                      </button>
                    )}
                    <button onClick={() => remove.mutate(n.id)} className="text-xs text-red-600">
                      Delete
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </AppShell>
  );
}
