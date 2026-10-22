"use client";

import { Menu } from "@base-ui/react/menu";
import { ChevronDown, RotateCcw } from "lucide-react";
import { useState, useTransition } from "react";

import { resetDemo } from "@/app/(app)/try/actions";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/** The demo-copy chip with "Start a fresh demo". */
export function DemoMenu({ label }: { label: string }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  return (
    <>
      <Menu.Root>
        <Menu.Trigger className="inline-flex h-8 items-center gap-1 rounded-full bg-neutral-soft px-3 text-[13px] font-medium text-foreground hover:bg-black/[0.08]">
          <span className="hidden sm:inline">Demo</span> {label}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={6} align="end" className="z-40">
            <Menu.Popup className="min-w-56 rounded-2xl border border-border bg-card p-1.5 shadow-sheet outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
              <p className="px-3 pt-2 pb-1.5 text-xs text-muted-foreground">Your private copy of Northside {label}</p>
              <Menu.Item
                onClick={() => setConfirming(true)}
                className="flex cursor-default items-center gap-2 rounded-xl px-3 py-2 text-sm outline-none data-highlighted:bg-canvas"
              >
                <RotateCcw className="size-4 text-muted-foreground" /> Start a fresh demo
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        busy={pending}
        spec={{
          title: "Start a fresh demo?",
          body: `The names, messages and emails in Northside ${label} are deleted now, and any open hold is released without a fee. Then you start a new copy with clean sample data.`,
          confirmLabel: "Start fresh",
        }}
        onConfirm={() =>
          startTransition(async () => {
            try {
              await resetDemo();
            } finally {
              // The redirect usually unmounts this menu; never leave the dialog open behind it.
              setConfirming(false);
            }
          })
        }
      />
    </>
  );
}
