import type { ReactNode } from "react";
import * as DM from "@radix-ui/react-dropdown-menu";
import * as CM from "@radix-ui/react-context-menu";
import { cn } from "@/lib/utils";

const contentCls =
  "hud z-50 flex flex-col rounded-card border border-accent/40 bg-overlay/97 p-1.5 graphite:border-line-strong graphite:bg-overlay hud:shadow-[0_0_40px_rgba(77,163,255,0.12),0_16px_48px_rgba(0,0,0,0.5)] graphite:shadow-(--shadow-pop) outline-none data-[state=open]:animate-[menu-in_180ms_ease-out]";

const itemCls = (danger?: boolean) =>
  cn(
    "flex h-8 cursor-pointer items-center gap-2.5 rounded-chip px-2 text-left outline-none select-none",
    "data-[highlighted]:bg-accent/12 graphite:data-[highlighted]:bg-hover hud:data-[highlighted]:shadow-[inset_0_0_0_1px_rgba(77,163,255,0.45)]",
    "data-[disabled]:cursor-default data-[disabled]:text-muted",
    danger && "text-danger-soft",
  );

const labelCls = "px-2 pt-1.5 pb-1 font-display text-[12px] font-semibold tracking-[0.16em] text-muted uppercase graphite:font-medium";
const separatorCls = "mx-1 my-1.5 h-px bg-line";

interface ItemProps {
  icon?: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onSelect?: () => void;
}

function ItemBody({ icon, children, hint, disabled, danger }: Omit<ItemProps, "onSelect">) {
  return (
    <>
      {icon && <span className={cn("flex text-accent graphite:text-muted", disabled && "text-muted", danger && "text-danger-soft")}>{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {hint && <span className="font-mono text-[10.5px] text-muted">{hint}</span>}
    </>
  );
}

export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;

export function MenuContent({
  children,
  align = "start",
  side = "bottom",
  width = 300,
}: {
  children: ReactNode;
  align?: "start" | "end" | "center";
  side?: "top" | "bottom" | "left" | "right";
  width?: number;
}) {
  return (
    <DM.Portal>
      <DM.Content align={align} side={side} sideOffset={6} style={{ width }} className={contentCls}>
        {children}
      </DM.Content>
    </DM.Portal>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DM.Label className={labelCls}>{children}</DM.Label>;
}

export function MenuSeparator() {
  return <DM.Separator className={separatorCls} />;
}

export function MenuItem({ onSelect, disabled, danger, ...body }: ItemProps) {
  return (
    <DM.Item disabled={disabled} onSelect={onSelect} className={itemCls(danger)}>
      <ItemBody disabled={disabled} danger={danger} {...body} />
    </DM.Item>
  );
}

/** Right-click menu with the same look as `Menu`. */
export const ContextMenu = CM.Root;
export const ContextMenuTrigger = CM.Trigger;

export function ContextMenuContent({ children, width = 240 }: { children: ReactNode; width?: number }) {
  return (
    <CM.Portal>
      {/* Don't pull focus back on close: items often focus an inline input. */}
      <CM.Content style={{ width }} className={contentCls} onCloseAutoFocus={(e) => e.preventDefault()}>
        {children}
      </CM.Content>
    </CM.Portal>
  );
}

export function ContextMenuLabel({ children }: { children: ReactNode }) {
  return <CM.Label className={cn(labelCls, "truncate")}>{children}</CM.Label>;
}

export function ContextMenuSeparator() {
  return <CM.Separator className={separatorCls} />;
}

export function ContextMenuItem({ onSelect, disabled, danger, ...body }: ItemProps) {
  return (
    <CM.Item disabled={disabled} onSelect={onSelect} className={itemCls(danger)}>
      <ItemBody disabled={disabled} danger={danger} {...body} />
    </CM.Item>
  );
}
