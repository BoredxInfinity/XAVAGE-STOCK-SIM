import type { Theme } from "@/components/theme-provider";

/**
 * Colours for the lightweight-charts instances.
 *
 * The chart library takes literal colour strings at option time and does not
 * resolve CSS custom properties, so the palette has to be mirrored here
 * rather than read off `var(--color-*)`. Keep these in step with the two
 * theme blocks in src/app/globals.css — they are the same values.
 */
export type ChartPalette = ReturnType<typeof chartPalette>;

export function chartPalette(theme: Theme) {
  const light = theme === "light";

  const neon = light ? "#2563eb" : "#4d8dff";
  const neonDeep = light ? "#1e40af" : "#1e5cf0";
  const violet = light ? "#7c3aed" : "#a855f7";
  const up = light ? "#00875a" : "#00e19b";
  const down = light ? "#d1204a" : "#ff3d6e";

  return {
    neon, violet, up, down,

    /** layout.textColor — matches --color-text-dim */
    text: light ? "#55597a" : "#a6a7c4",
    /** grid + axis borders — matches --color-border at low alpha */
    grid: light ? "rgba(217,220,234,.85)" : "rgba(42,42,71,.55)",
    border: light ? "#d9dcea" : "#2a2a47",

    crosshair: neon,
    crosshairLabel: neonDeep,

    /** the volume histogram's default (unbucketed) bar */
    volume: light ? "rgba(37,99,235,.22)" : "rgba(77,141,255,.32)",
    volumeUp: light ? "rgba(0,135,90,.26)" : "rgba(0,225,155,.28)",
    volumeDown: light ? "rgba(209,32,74,.24)" : "rgba(255,61,110,.28)",

    /** area series fill, top → bottom */
    areaTop: light ? "rgba(37,99,235,.22)" : "rgba(77,141,255,.34)",
    areaBottom: light ? "rgba(124,58,237,.02)" : "rgba(168,85,247,.02)",

    /** equity curve fills, keyed on whether the book is up or down */
    equityUpTop: light ? "rgba(0,135,90,.20)" : "rgba(0,225,155,.28)",
    equityDownTop: light ? "rgba(209,32,74,.18)" : "rgba(255,61,110,.28)",
    equityBottom: light ? "rgba(124,58,237,.02)" : "rgba(168,85,247,.02)",

    /** the dashed "start" baseline on the equity curve */
    baseline: light ? "rgba(85,89,122,.6)" : "rgba(166,167,196,.55)",
  };
}
