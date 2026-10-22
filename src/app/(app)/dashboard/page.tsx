import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { OwnerDashboard } from "@/components/dashboard/owner-dashboard";
import { getDb } from "@/db/client";
import { dashboardData } from "@/server/dashboard/queries";
import { currentDemoWorkspace } from "@/server/workspaces/session";

export const metadata: Metadata = { title: "Owner dashboard", robots: { index: false, follow: false } };

/** The owner view of the visitor's demo copy (stage 7 minimum; stage 9 builds the full dashboard). */
export default async function DashboardPage() {
  const ws = await currentDemoWorkspace();
  if (!ws) redirect("/try");
  const data = await dashboardData(getDb(), ws);
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-10">
      <header>
        <p className="text-sm font-medium text-brand">Step 3 · Be the owner</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {ws.name} <span className="text-base font-normal text-muted-foreground">· demo copy {ws.label}</span>
        </h1>
      </header>
      <OwnerDashboard data={data} />
    </div>
  );
}
