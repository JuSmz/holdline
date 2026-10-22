import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { OwnerDashboard } from "@/components/dashboard/owner-dashboard";
import { getDb } from "@/db/client";
import { dashboardState } from "@/server/dashboard/queries";
import { currentDemoWorkspace } from "@/server/workspaces/session";

export const metadata: Metadata = { title: "Owner dashboard", robots: { index: false, follow: false } };

/**
 * The owner view of the visitor's demo copy (SPEC §18). The page polls /api/dashboard/state from here on;
 * the client reads `?tab=` itself, so Back into the page shows the tab its URL names.
 */
export default async function DashboardPage() {
  const ws = await currentDemoWorkspace();
  if (!ws) redirect("/try");
  const state = await dashboardState(getDb(), ws, new Date());
  return <OwnerDashboard initial={{ ok: true, ...state }} />;
}
