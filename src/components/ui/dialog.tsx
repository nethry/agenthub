import type { ReactNode } from "react";
import * as RD from "@radix-ui/react-dialog";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

type Tone = "accent" | "warn" | "danger";

const toneCls: Record<Tone, string> = {
  accent: "border-accent/40 graphite:border-line-strong hud:shadow-[0_0_40px_rgba(77,163,255,0.10),0_24px_64px_rgba(0,0,0,0.6)] graphite:shadow-(--shadow-pop)",
  warn: "hud-warn border-warn/50 hud:shadow-[0_0_40px_rgba(255,181,71,0.08),0_24px_64px_rgba(0,0,0,0.6)] graphite:shadow-(--shadow-pop)",
  danger: "hud-danger border-danger/50 hud:shadow-[0_0_40px_rgba(255,84,112,0.08),0_24px_64px_rgba(0,0,0,0.6)] graphite:shadow-(--shadow-pop)",
};

/**
 * Modal dialog with corner brackets. `alert` dialogs (destructive/caution) use
 * role=alertdialog semantics via an eyebrow and explicit description.
 */
export function Dialog({
  open,
  onClose,
  title,
  eyebrow,
  description,
  tone = "accent",
  width = 460,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  tone?: Tone;
  width?: number;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <RD.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <RD.Portal>
        <RD.Overlay asChild>
          <motion.div
            className="fixed inset-0 z-40 bg-scrim backdrop-blur-[4px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.18 }}
          />
        </RD.Overlay>
        <RD.Content
          role={tone === "accent" ? "dialog" : "alertdialog"}
          aria-describedby={description ? undefined : undefined}
          className="fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 outline-none"
          style={{ width }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }}
            className={cn("hud flex flex-col gap-3 rounded-dialog border bg-surface p-5 graphite:bg-overlay", toneCls[tone])}
          >
            {eyebrow && (
              <span
                className={cn(
                  "font-mono text-[10.5px]",
                  tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-accent",
                )}
              >
                {eyebrow}
              </span>
            )}
            <RD.Title className="m-0 font-display text-[18px] font-bold tracking-[0.1em] uppercase graphite:text-[16px] graphite:font-semibold">{title}</RD.Title>
            {description ? (
              <RD.Description className="m-0 text-[13px] leading-5 text-body">{description}</RD.Description>
            ) : (
              <RD.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</RD.Description>
            )}
            {children}
            {footer && <div className="mt-2 flex items-center justify-end gap-2">{footer}</div>}
          </motion.div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
