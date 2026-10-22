import { cn } from "cn";
import Link from "next/link";

/** Links styled as a segmented control (the Customer | Owner switch). */
export function SegmentedNav({
  items,
  active,
  className,
}: {
  items: { href: string; label: string; key: string }[];
  active: string | null;
  className?: string;
}) {
  return (
    <nav className={cn("inline-flex rounded-full bg-neutral-soft p-0.5", className)} aria-label="Demo views">
      {items.map((item) => (
        <Link
          key={item.key}
          href={item.href}
          aria-current={active === item.key ? "page" : undefined}
          className={cn(
            "rounded-full px-3.5 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground",
            active === item.key && "bg-card text-foreground shadow-sm",
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
