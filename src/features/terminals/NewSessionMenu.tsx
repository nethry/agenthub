import type { ReactNode } from "react";
import { Plus, SquareTerminal, TerminalSquare } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { openSettings, spawnPreset, spawnShell } from "@/app/actions";
import { set, useApp } from "@/app/store";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";

/**
 * New terminal: shells, your saved commands (Settings › Terminals & shells)
 * and a one-off custom command. AI agents run in Chat, not here.
 */
export function NewSessionMenu({ projectId, children, align = "end" }: { projectId: string; children: ReactNode; align?: "start" | "end" }) {
  const commands = useApp(useShallow((s) => s.presets.filter((p) => p.enabled)));
  const shells = useApp(useShallow((s) => s.shells.filter((sh) => sh.available)));
  const defaultShell = useApp((s) => s.defaultShell);

  return (
    <Menu>
      <MenuTrigger asChild>{children}</MenuTrigger>
      <MenuContent align={align}>
        <MenuLabel>Shells</MenuLabel>
        {shells.map((sh) => (
          <MenuItem
            key={sh.id}
            icon={<SquareTerminal className="size-4" />}
            hint={
              sh.id === defaultShell ? (
                "DEFAULT"
              ) : sh.preview ? (
                <span className="border border-warn px-[5px] text-[10px] text-warn">PREVIEW</span>
              ) : undefined
            }
            onSelect={() => void spawnShell(projectId, sh.id)}
          >
            {sh.name}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuLabel>Your commands</MenuLabel>
        {commands.length === 0 && (
          <MenuItem icon={<TerminalSquare className="size-4" />} onSelect={() => openSettings("terminals")}>
            Save a command…
          </MenuItem>
        )}
        {commands.map((p, i) => {
          const found = !!p.resolvedPath || p.shellProfile !== "direct";
          return (
            <MenuItem
              key={p.id}
              icon={<TerminalSquare className="size-4" />}
              disabled={!found}
              hint={found ? (i < 9 ? `ALT ${i + 1}` : undefined) : <span className="text-danger-soft">NOT FOUND</span>}
              onSelect={() => void spawnPreset(projectId, p.id)}
            >
              {p.displayName}
            </MenuItem>
          );
        })}
        <MenuSeparator />
        <MenuItem icon={<Plus className="size-4" />} onSelect={() => set({ dialog: { type: "customCommand" } })}>
          Custom command…
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
