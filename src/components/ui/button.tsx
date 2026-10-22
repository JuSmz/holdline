import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

/** Pill buttons (docs/design-system.md): one blue primary per screen, gray secondary, text links. */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-2 rounded-full border border-transparent font-medium whitespace-nowrap transition-[background-color,color,box-shadow,transform] duration-150 outline-none select-none focus-visible:ring-4 focus-visible:ring-brand/25 active:not-aria-[haspopup]:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-brand text-brand-foreground hover:bg-brand/90",
        dark: "bg-foreground text-background hover:bg-foreground/85",
        secondary: "bg-neutral-soft text-foreground hover:bg-black/[0.08]",
        outline: "border-border bg-card text-foreground shadow-sm hover:bg-canvas",
        ghost: "text-foreground hover:bg-black/[0.05]",
        destructive: "bg-danger-soft text-danger hover:bg-danger/15",
        link: "h-auto rounded-none px-0 text-brand underline-offset-4 hover:underline",
      },
      size: {
        xs: "h-7 px-3 text-xs",
        sm: "h-8 px-3.5 text-[13px]",
        default: "h-10 px-5 text-[15px]",
        lg: "h-12 px-6 text-base",
        icon: "size-10",
        "icon-sm": "size-8",
      },
    },
    compoundVariants: [{ variant: "link", className: "h-auto px-0" }],
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
