"use client";

import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

/** A side sheet on desktop, a bottom sheet on phones (Base UI Dialog). */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/20 transition-opacity duration-300 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed inset-x-0 bottom-0 z-40 flex max-h-[90dvh] flex-col rounded-t-3xl bg-card shadow-sheet transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] outline-none data-ending-style:translate-y-full data-starting-style:translate-y-full sm:inset-y-3 sm:right-3 sm:left-auto sm:max-h-none sm:w-[30rem] sm:rounded-3xl sm:data-ending-style:translate-x-[110%] sm:data-ending-style:translate-y-0 sm:data-starting-style:translate-x-[110%] sm:data-starting-style:translate-y-0">
          <div className="flex items-start justify-between gap-4 border-b border-border px-6 pt-6 pb-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-lg font-semibold tracking-tight">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-0.5 text-sm text-muted-foreground">{description}</Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close
              className="grid size-8 shrink-0 place-items-center rounded-full bg-neutral-soft text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-5">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
