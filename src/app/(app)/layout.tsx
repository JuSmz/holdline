import type { ReactNode } from "react";

import { AppHeader } from "@/components/site/app-header";

/**
 * Route group for every page that reads the database (/try, /pay, /dashboard — stages 5+).
 * Forces request-time rendering so `next build` never prerenders DB data or needs the
 * (private) database at build time. Marketing pages live in (marketing) and stay static.
 */
export const dynamic = "force-dynamic";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <AppHeader />
      <main className="flex-1 bg-canvas">{children}</main>
    </>
  );
}
