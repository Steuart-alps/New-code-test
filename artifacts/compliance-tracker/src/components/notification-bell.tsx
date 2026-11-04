import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Bell, CheckCheck } from "lucide-react";
import { apiFetch, getApiErrorMessage } from "@/lib/api";
import { useAuth } from "@/context/auth-context";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface AppNotification {
  id: number;
  module: string | null;
  siteId: number | null;
  kind: string;
  title: string;
  body: string | null;
  linkPath: string | null;
  createdAt: string | null;
  readAt: string | null;
}

interface NotificationList {
  notifications: AppNotification[];
  unreadCount: number;
}

const POLL_MS = 60_000;
const LAST_TOASTED_KEY = "complytrack:notifications:lastToasted";

function readLastToasted(scope: string): number {
  try {
    return Number(window.localStorage.getItem(`${LAST_TOASTED_KEY}:${scope}`)) || 0;
  } catch {
    return 0;
  }
}

function writeLastToasted(scope: string, id: number): void {
  try {
    window.localStorage.setItem(`${LAST_TOASTED_KEY}:${scope}`, String(id));
  } catch {
    // Storage unavailable: pop-ups may repeat after a reload, nothing worse.
  }
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

/** Only in-app paths are followed; anything else stays on the current page. */
function safeLink(path: string | null): string | null {
  return path && path.startsWith("/") && !path.startsWith("//") ? path : null;
}

/**
 * Header bell: the signed-in user's in-app reminders for the active business.
 * Polls every minute while the tab is visible and pops up a toast when a new
 * unread reminder arrives (each one pops up once per browser).
 */
export function NotificationBell() {
  const { user, activeClientId, client, billingLocked } = useAuth();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const scope = `${user?.id ?? "guest"}:${activeClientId ?? client?.id ?? "none"}`;
  const queryKey = ["notifications", scope];

  const { data } = useQuery({
    queryKey,
    enabled: Boolean(user) && !billingLocked,
    queryFn: async (): Promise<NotificationList> => {
      const response = await apiFetch("/notifications");
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Couldn't load notifications"));
      return response.json();
    },
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    staleTime: POLL_MS / 2,
    retry: false,
  });

  const notifications = data?.notifications ?? [];
  const unreadCount = data?.unreadCount ?? 0;

  const markRead = async (notification: AppNotification) => {
    if (notification.readAt) return;
    queryClient.setQueryData<NotificationList>(queryKey, (current) => current && {
      notifications: current.notifications.map((item) =>
        item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item),
      unreadCount: Math.max(0, current.unreadCount - 1),
    });
    try {
      await apiFetch(`/notifications/${notification.id}/read`, { method: "POST", body: "{}" });
    } finally {
      void queryClient.invalidateQueries({ queryKey });
    }
  };

  const openNotification = (notification: AppNotification) => {
    setOpen(false);
    void markRead(notification);
    const link = safeLink(notification.linkPath);
    if (link) setLocation(link);
  };

  const markAllRead = async () => {
    queryClient.setQueryData<NotificationList>(queryKey, (current) => current && {
      notifications: current.notifications.map((item) => item.readAt ? item : { ...item, readAt: new Date().toISOString() }),
      unreadCount: 0,
    });
    try {
      await apiFetch("/notifications/read-all", { method: "POST", body: "{}" });
    } finally {
      void queryClient.invalidateQueries({ queryKey });
    }
  };

  // Pop-up for reminders that arrived since the last poll (or since this
  // browser last showed one), newest first.
  useEffect(() => {
    if (!data) return;
    const lastToasted = readLastToasted(scope);
    const fresh = data.notifications.filter((item) => !item.readAt && item.id > lastToasted);
    if (fresh.length === 0) return;
    const newest = fresh.reduce((a, b) => (b.id > a.id ? b : a));
    writeLastToasted(scope, newest.id);
    toast({
      title: fresh.length === 1 ? newest.title : `${fresh.length} new reminders`,
      description: fresh.length === 1 ? newest.body ?? undefined : newest.title,
      action: safeLink(newest.linkPath) && fresh.length === 1 ? (
        <ToastAction altText="Open reminder" onClick={() => openNotification(newest)}>View</ToastAction>
      ) : (
        <ToastAction altText="Show reminders" onClick={() => setOpen(true)}>Show</ToastAction>
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, scope]);

  if (!user || billingLocked) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-sm text-[#162D42] hover:bg-muted transition-colors"
          aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
          title="Notifications"
          data-testid="button-notifications"
        >
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <span
              className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-white"
              data-testid="badge-notifications-unread"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[min(22rem,calc(100vw-1.5rem))] rounded-sm p-0">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <span className="text-sm font-semibold text-[#162D42]">Reminders</span>
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={() => void markAllRead()}
              className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              data-testid="button-notifications-read-all"
            >
              <CheckCheck className="h-3.5 w-3.5" /> Mark all read
            </button>
          )}
        </div>
        {notifications.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No reminders. Unfinished checks for the tracks you own will appear here.
          </p>
        ) : (
          <ul className="max-h-[min(24rem,70vh)] overflow-y-auto divide-y divide-border">
            {notifications.map((notification) => (
              <li key={notification.id}>
                <button
                  type="button"
                  onClick={() => openNotification(notification)}
                  className={cn(
                    "flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60",
                    !notification.readAt && "bg-sky-50/70",
                  )}
                  data-testid={`notification-${notification.id}`}
                >
                  <span
                    className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", notification.readAt ? "bg-transparent" : "bg-destructive")}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block text-sm text-[#162D42] break-words", !notification.readAt && "font-semibold")}>
                      {notification.title}
                    </span>
                    {notification.body && (
                      <span className="mt-0.5 block text-xs text-muted-foreground break-words">{notification.body}</span>
                    )}
                    <span className="mt-1 block text-[11px] text-muted-foreground/80">{timeAgo(notification.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
