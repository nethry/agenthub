import { forwardRef, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export function FieldLabel({ htmlFor, children, as = "label" }: { htmlFor?: string; children: ReactNode; as?: "label" | "legend" }) {
  const cls = "font-display text-[12px] font-semibold tracking-[0.14em] text-body uppercase";
  if (as === "legend") return <legend className={cn(cls, "mb-1.5 p-0")}>{children}</legend>;
  return (
    <label htmlFor={htmlFor} className={cls}>
      {children}
    </label>
  );
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
      {children}
      {hint && <div className="text-[12px] leading-[18px] text-muted">{hint}</div>}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(
  function Input({ className, mono, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "h-[34px] min-w-0 border border-line bg-well px-2.5 outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-dim focus:border-accent focus:shadow-[0_0_12px_rgba(77,163,255,0.3)]",
          mono && "font-mono text-[12.5px]",
          className,
        )}
        spellCheck={false}
        autoComplete="off"
        {...props}
      />
    );
  },
);

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-[34px] border border-line bg-well px-2 outline-none focus:border-accent focus:shadow-[0_0_12px_rgba(77,163,255,0.3)]",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex h-5 w-[38px] shrink-0 border p-0.5 transition-colors duration-200",
        checked ? "justify-end border-accent bg-accent/18" : "justify-start border-line-strong bg-transparent",
      )}
    >
      <span className={cn("size-3.5", checked ? "bg-accent shadow-[0_0_8px_#4DA3FF]" : "bg-line-strong")} />
    </button>
  );
}

/** Arguments as chips: each one is passed to the process as-is. */
export function ArgsInput({ id, value, onChange }: { id: string; value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    if (!draft) return;
    onChange([...value, draft]);
    setDraft("");
  };
  return (
    <div
      className="flex min-h-[34px] flex-wrap items-center gap-1.5 border border-line bg-well p-1.5 focus-within:border-accent focus-within:shadow-[0_0_12px_rgba(77,163,255,0.3)]"
      onClick={(e) => (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.focus()}
    >
      {value.map((arg, i) => (
        <span
          key={`${arg}-${i}`}
          className="inline-flex h-[22px] items-center gap-1 border border-accent/40 bg-accent/8 pr-1 pl-2 font-mono text-[12px]"
        >
          {arg}
          <button
            type="button"
            aria-label={`Remove argument ${arg}`}
            className="flex size-[18px] items-center justify-center border-0 bg-transparent p-0 text-muted hover:text-fg"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        placeholder={value.length ? "" : "Add argument, press Enter"}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={commit}
        spellCheck={false}
        className="h-[22px] min-w-[120px] flex-1 border-0 bg-transparent font-mono text-[12px] outline-none placeholder:text-dim"
      />
    </div>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn("kbd", className)}>{children}</kbd>;
}

export function SectionLabel({ index, children, className }: { index?: string; children: ReactNode; className?: string }) {
  return (
    <h2 className={cn("m-0 font-display text-[12px] font-semibold tracking-[0.16em] text-muted uppercase", className)}>
      {index && <span className="mr-1.5 text-accent">{index}</span>}
      {children}
    </h2>
  );
}
