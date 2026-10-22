"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useState } from "react";

import { Button } from "./button";

export type ConfirmSpec = {
  title: string;
  /** What happens, in one or two sentences. */
  body: string;
  /** The money line: exact amount and the rule that applies. */
  money?: string;
  confirmLabel: string;
  /** The dismiss button. Never "Cancel" (it reads like "Cancel booking"); defaults to "Not now". */
  cancelLabel?: string;
  tone?: "default" | "destructive";
};

/** Every owner action asks here first (SPEC §18): never `window.confirm`. */
export function ConfirmDialog({
  spec,
  open,
  busy,
  onOpenChange,
  onConfirm,
}: {
  spec: ConfirmSpec | null;
  open: boolean;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  // The popup stays mounted for its exit transition after `spec` goes null: keep showing the last one.
  const [shown, setShown] = useState<ConfirmSpec | null>(spec);
  if (spec && spec !== shown) setShown(spec);
  const content = spec ?? shown;

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop
          forceRender
          className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px] transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0"
        />
        <AlertDialog.Popup className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-[26rem] -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-card p-6 shadow-sheet transition-[scale,opacity] duration-200 ease-out outline-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
          {content ? (
            <>
              <AlertDialog.Title className="text-lg font-semibold tracking-tight">{content.title}</AlertDialog.Title>
              <AlertDialog.Description className="mt-2 text-[15px] text-muted-foreground">
                {content.body}
              </AlertDialog.Description>
              {content.money ? (
                <p className="mt-4 rounded-2xl bg-canvas px-4 py-3 text-[15px] font-medium tabular-nums">
                  {content.money}
                </p>
              ) : null}
              {/* Stacked on phones (confirm on top), side by side from sm up: long labels never overflow. */}
              <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <AlertDialog.Close render={<Button variant="secondary" className="w-full sm:w-auto" disabled={busy} />}>
                  {content.cancelLabel ?? "Not now"}
                </AlertDialog.Close>
                <Button
                  variant={content.tone === "destructive" ? "destructive" : "default"}
                  className="w-full sm:w-auto"
                  disabled={busy || !open}
                  onClick={onConfirm}
                >
                  {busy ? "Working…" : content.confirmLabel}
                </Button>
              </div>
            </>
          ) : null}
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
