import { Bug, Lightbulb } from "lucide-react";
import type { BacklogKind } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Feature (tag color) or bug (danger); always shown next to its label or ID. */
export function KindIcon({ kind, className }: { kind: BacklogKind; className?: string }) {
  return kind === "bug" ? <Bug className={cn("text-danger", className)} aria-hidden="true" /> : <Lightbulb className={cn("text-tag", className)} aria-hidden="true" />;
}
