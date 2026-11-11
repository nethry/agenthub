export const LIST_MIN = 200;
export const PANEL_MIN = 280;
export const TRANSCRIPT_MIN = 360;

export function panelWidth(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value))) : fallback;
}

/** Fit visible panels without changing the user's saved preferred widths. */
export function chatLayout(width: number, list: number, panel: number, showList: boolean, showPanel: boolean) {
  const listMin = showList ? LIST_MIN : 0;
  const panelMin = showPanel ? PANEL_MIN : 0;
  const preferredList = showList ? panelWidth(list, 268, LIST_MIN, 480) : 0;
  const preferredPanel = showPanel ? panelWidth(panel, 380, PANEL_MIN, 800) : 0;
  const available = Math.max(listMin + panelMin, width - TRANSCRIPT_MIN);
  const extra = preferredList + preferredPanel - listMin - panelMin;
  const scale = extra > 0 ? Math.min(1, (available - listMin - panelMin) / extra) : 0;
  const listWidth = Math.floor(listMin + (preferredList - listMin) * scale);
  const panelSize = Math.floor(panelMin + (preferredPanel - panelMin) * scale);
  return {
    list: listWidth,
    panel: panelSize,
    listMax: Math.max(LIST_MIN, Math.min(480, available - panelSize)),
    panelMax: Math.max(PANEL_MIN, Math.min(800, available - listWidth)),
  };
}
