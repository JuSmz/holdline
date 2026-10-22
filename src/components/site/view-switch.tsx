"use client";

import { usePathname } from "next/navigation";

import { SegmentedNav } from "@/components/ui/segmented-nav";

/** Customer | Owner: the two sides of the demo. */
export function ViewSwitch() {
  const path = usePathname();
  const active = path.startsWith("/dashboard")
    ? "owner"
    : path.startsWith("/try") || path.startsWith("/pay")
      ? "customer"
      : null;
  return (
    <SegmentedNav
      active={active}
      items={[
        { key: "customer", href: "/try", label: "Customer" },
        { key: "owner", href: "/dashboard", label: "Owner" },
      ]}
    />
  );
}
