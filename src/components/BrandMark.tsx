import { cn } from "@/lib/utils";

/**
 * EasyVC mark — three ascending rules on ink. Reads as a pipeline / a ledger,
 * not as a generic startup glyph.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-[3px] bg-primary text-primary-foreground shrink-0",
        className,
      )}
      aria-hidden="true"
    >
      <svg viewBox="0 0 20 20" className="h-[62%] w-[62%]" fill="none">
        <rect x="2" y="12.5" width="4" height="5.5" rx="0.75" fill="currentColor" opacity="0.55" />
        <rect x="8" y="8" width="4" height="10" rx="0.75" fill="currentColor" opacity="0.8" />
        <rect x="14" y="2" width="4" height="16" rx="0.75" fill="hsl(var(--brand))" />
      </svg>
    </span>
  );
}

export function BrandWordmark({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2.5", collapsed && "justify-center")}>
      <BrandMark className="h-7 w-7" />
      {!collapsed && (
        <div className="flex flex-col leading-none min-w-0">
          <span className="text-[15px] font-semibold tracking-tight text-foreground">EasyVC</span>
          <span className="mt-1 text-[9px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Deal OS
          </span>
        </div>
      )}
    </div>
  );
}
