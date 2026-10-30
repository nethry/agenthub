import { useMemo } from "react";
import { LETTER_TITLE, LETTER_TONE, treeLetters } from "./model";
import { useGit } from "./store";

/** Git status letter per project-relative path, for the file tree. */
export function useTreeLetters(projectId: string): Record<string, string> {
  const status = useGit((s) => s.projects[projectId]?.status ?? null);
  return useMemo(() => treeLetters(status), [status]);
}

export function GitStatusLetter({ letter }: { letter: string | undefined }) {
  if (!letter) return null;
  return (
    <span className={`w-2.5 shrink-0 text-center font-mono text-[10.5px] ${LETTER_TONE[letter] ?? "text-muted"}`} title={LETTER_TITLE[letter]}>
      {letter}
    </span>
  );
}
