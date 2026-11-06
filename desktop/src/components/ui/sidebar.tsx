import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SidebarProvider({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full w-full overflow-hidden bg-[hsl(var(--background))]">
      {children}
    </div>
  );
}

export function Sidebar({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="p-2 pr-0" style={{ width: 264 }}>
      <div
        className={cn(
          "flex h-full w-full flex-col border border-[hsl(var(--border))] bg-[hsl(var(--card))] text-[hsl(var(--card-foreground))]",
          className
        )}
        {...props}
      >
        {children}
      </div>
    </div>
  );
}

export function SidebarHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-2 p-4", className)} {...props} />;
}

export function SidebarContent({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("flex flex-1 flex-col gap-1 overflow-y-auto p-2", className)} {...props} />
  );
}

export function SidebarFooter({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "mt-auto flex flex-col gap-1 border-t border-[hsl(var(--border))] p-2",
        className
      )}
      {...props}
    />
  );
}

export function SidebarGroup({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1", className)} {...props} />;
}

export function SidebarMenu({
  className,
  ...props
}: HTMLAttributes<HTMLUListElement>) {
  return <ul className={cn("flex w-full flex-col gap-1", className)} {...props} />;
}

export function SidebarMenuItem({
  className,
  ...props
}: HTMLAttributes<HTMLLIElement>) {
  return <li className={cn("group/menu-item relative", className)} {...props} />;
}

export function SidebarMenuButton({
  active,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors",
        active
          ? "bg-[hsl(var(--accent))] font-medium text-[hsl(var(--accent-foreground))]"
          : "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]/60 hover:text-[hsl(var(--foreground))]",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function SidebarInset({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "relative flex h-full flex-1 flex-col overflow-hidden p-2 pl-2",
        className
      )}
      {...props}
    />
  );
}
