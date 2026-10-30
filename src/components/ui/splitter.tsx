import { useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Vertical drag handle. `side` is which neighbour the width belongs to:
 * "left" grows when dragged right, "right" grows when dragged left.
 */
export function Splitter({
  value,
  min,
  max,
  side,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  side: "left" | "right";
  onChange: (v: number) => void;
  label: string;
}) {
  const start = useRef<{ x: number; v: number } | null>(null);
  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)));

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 10;
        if (e.key === "ArrowLeft") onChange(clamp(value + (side === "right" ? step : -step)));
        if (e.key === "ArrowRight") onChange(clamp(value + (side === "right" ? -step : step)));
      }}
      onPointerDown={(e) => {
        start.current = { x: e.clientX, v: value };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const dx = e.clientX - start.current.x;
        onChange(clamp(start.current.v + (side === "right" ? -dx : dx)));
      }}
      onPointerUp={() => (start.current = null)}
      className={cn(
        "group relative -mx-[5px] w-2.5 shrink-0 cursor-col-resize outline-none",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors after:duration-200",
        "hover:after:bg-accent/50 focus-visible:after:bg-accent",
      )}
    />
  );
}
