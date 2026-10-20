import Link from "next/link";

import { Logo } from "@/components/brand/logo";

export function SiteHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" aria-label="Holdline home">
          <Logo />
        </Link>
        <span className="rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground">
          PayPal Sandbox demo
        </span>
      </div>
    </header>
  );
}
