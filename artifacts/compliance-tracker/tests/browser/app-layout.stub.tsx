// Harness stand-in for "@/components/layout": the page without the app's
// sidebar and header, which need the router and a signed-in session.
import type { ReactNode } from "react";

export function AppLayout({ children, title }: { children: ReactNode; title: string }) {
  return <main className="p-6"><h1 className="text-xl font-bold mb-4">{title}</h1>{children}</main>;
}
