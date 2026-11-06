import type { ComponentType } from "react";
import { cn } from "@/lib/utils";

export default function ToolButton({
  icon: Icon,
  label,
  active,
  disabled,
  onClick,
  className
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center border border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40",
        active && "border-border bg-accent text-accent-foreground",
        className
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}