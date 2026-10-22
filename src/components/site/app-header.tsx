import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { currentDemoWorkspace } from "@/server/workspaces/session";

import { DemoMenu } from "./demo-menu";
import { ViewSwitch } from "./view-switch";

/**
 * The app header: where you are (your demo copy) and the Customer | Owner switch
 * (docs/design-system.md). Translucent and sticky, like a system toolbar.
 */
export async function AppHeader() {
  const ws = await currentDemoWorkspace();
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-white/75 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <Link href="/" aria-label="Holdline home" className="shrink-0">
          {/* The glyph alone below sm: with the switch and the demo chip the header must fit 360 px. */}
          <Logo wordmarkClassName="hidden sm:inline" />
        </Link>
        {ws ? (
          <div className="flex min-w-0 items-center gap-2">
            <ViewSwitch />
            <DemoMenu label={ws.label} />
          </div>
        ) : (
          <span className="rounded-full bg-neutral-soft px-3 py-1 text-xs font-medium text-muted-foreground">
            PayPal Sandbox demo
          </span>
        )}
      </div>
    </header>
  );
}
