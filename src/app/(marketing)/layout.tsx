import Link from "next/link";
import type { ReactNode } from "react";

import { Logo } from "@/components/brand/logo";
import { buttonVariants } from "@/components/ui/button";

/** Static marketing pages: a light header with the one way in, the live demo. */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="sticky top-0 z-30 border-b border-border bg-white/75 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5 sm:px-6">
          <Link href="/" aria-label="Holdline home">
            <Logo />
          </Link>
          <Link href="/try" className={buttonVariants({ size: "sm" })}>
            Try the live demo
          </Link>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </>
  );
}
