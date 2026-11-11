import { badgeTone, cn, initials, type BadgeTone } from "@/lib/utils";

const tones: Record<BadgeTone, string> = {
  accent: "border-accent text-accent",
  warn: "border-warn/60 text-warn",
  run: "border-run/60 text-run",
  tag: "border-tag/60 text-tag",
  neutral: "border-line-strong text-badge",
};

export function ProjectBadge({ id, name, size = 28, active }: { id: string; name: string; size?: number; active?: boolean }) {
  const tone = active ? "accent" : badgeTone(id);
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={cn(
        "flex shrink-0 items-center justify-center border font-display text-[13px] font-bold",
        tones[tone],
      )}
    >
      {initials(name)}
    </span>
  );
}

export function badgeTextClass(id: string) {
  return tones[badgeTone(id)].split(" ").find((c) => c.startsWith("text-"))!;
}
