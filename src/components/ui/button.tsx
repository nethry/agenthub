import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "danger" | "secondary" | "outline" | "ghost" | "danger-ghost" | "link";
type Size = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variants: Record<Variant, string> = {
  primary: "chamfer bg-accent-fill text-on-accent font-bold tracking-[0.14em] hover:bg-accent-fill-hover",
  danger: "chamfer bg-danger text-on-danger font-bold tracking-[0.14em] hover:brightness-110 graphite:border graphite:border-danger graphite:bg-transparent graphite:text-danger graphite:hover:bg-danger/10 graphite:hover:brightness-100",
  secondary: "border border-line bg-accent/[0.05] hover:border-line-strong hover:bg-accent/10 graphite:border-line-strong graphite:bg-raised graphite:hover:bg-hover",
  outline: "border border-line bg-transparent hover:border-line-strong hover:bg-accent/5 graphite:hover:bg-hover",
  ghost: "bg-transparent text-muted hover:text-fg hover:bg-accent/5 graphite:hover:bg-hover",
  "danger-ghost": "bg-transparent text-danger-soft hover:text-danger",
  link: "bg-transparent text-accent hover:text-accent-hover px-0! h-auto!",
};

const sizes: Record<Size, string> = {
  sm: "h-[26px] px-2.5 text-[12px]",
  md: "h-8 px-3.5 text-[13px]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-ctl border-0 font-display font-semibold uppercase graphite:font-medium tracking-[0.12em] whitespace-nowrap transition-colors duration-200 disabled:cursor-default disabled:opacity-45",
        sizes[size],
        variants[variant],
        (variant === "primary" || variant === "danger") && (size === "md" ? "px-4" : "px-3"),
        className,
      )}
      {...props}
    />
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  "aria-label": string;
  bordered?: boolean;
  size?: number;
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { bordered, size = 26, active, className, style, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      title={props["aria-label"]}
      style={{ width: size, height: size, ...style }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-ctl bg-transparent text-muted transition-colors duration-200 hover:text-fg disabled:opacity-40 graphite:hover:bg-hover",
        bordered ? "border border-line hover:border-line-strong" : "border-0",
        active && "bg-accent/12 text-accent",
        className,
      )}
      {...props}
    />
  );
});
