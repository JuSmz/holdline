/** The dashboard tabs (SPEC §18), linkable as /dashboard?tab=… — shared by the page and the client. */
export const DASHBOARD_TABS = [
  { key: "overview", label: "Overview" },
  { key: "bookings", label: "Bookings" },
  { key: "calls", label: "Calls" },
  { key: "payments", label: "Payments" },
  { key: "prices", label: "Price list" },
  { key: "outbox", label: "Outbox" },
] as const;
export type DashboardTab = (typeof DASHBOARD_TABS)[number]["key"];

export function tabFrom(value: string | string[] | undefined): DashboardTab {
  return DASHBOARD_TABS.find((t) => t.key === value)?.key ?? "overview";
}
