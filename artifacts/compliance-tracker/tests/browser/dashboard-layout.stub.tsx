// Harness stand-in for "@/components/layout": the dashboard without the app
// shell (sidebar, account menu), which this harness does not exercise.
import type { ReactNode } from "react";

export function AppLayout({ children }: { children: ReactNode; title: string }) {
  return <main>{children}</main>;
}
