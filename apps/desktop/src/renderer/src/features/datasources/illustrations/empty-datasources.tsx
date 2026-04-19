// Empty-state illustration for the datasources dashboard (task 4b.8).
//
// Design constraints (design.md Decision 12):
//   - Abstract geometric cloud/storage-lattice motif — no faces, mascots, 3D
//     renderings, or multicolour artwork.
//   - Monochrome strokes + a single theme-accent mark so the illustration
//     theme-switches via CSS alone (no JS required).
//   - ~240 x 160 viewBox so it scales cleanly in the empty-state panel.
//
// Colour strategy:
//   - Primary strokes use `stroke="currentColor"` so the illustration
//     inherits the parent's `color` (the text foreground). This means the
//     same SVG draws in dark grey on light theme and light grey on dark
//     theme without any extra wiring.
//   - The single accent mark (three stacked "connected datasource" tiles)
//     uses `fill="var(--primary)"`. The `--primary` CSS variable is
//     declared in globals.css and already resolves to an oklch() colour
//     value at both `:root` (light) and `.dark` (dark) scope — so the
//     accent re-colours automatically when the theme flips.
//
//   We intentionally do NOT use `hsl(var(--primary))` because the literals-
//   ban guardrail (scripts/literals-ban.test.ts) flags any `hsl(` / `rgb(`
//   / `oklch(` function call in feature code, and `--primary` resolves to
//   a complete colour value already — the extra `hsl()` wrapper is both
//   unnecessary and would break the guardrail.

export interface EmptyDatasourcesIllustrationProps
  extends React.SVGProps<SVGSVGElement> {
  /**
   * Override the accessible name rendered in the nested <title>. Defaults to
   * "No cloud datasources connected yet".
   */
  title?: string;
}

export function EmptyDatasourcesIllustration({
  title = "No cloud datasources connected yet",
  ...svgProps
}: EmptyDatasourcesIllustrationProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 240 160"
      role="img"
      aria-label={title}
      data-illustration="empty-datasources"
      fill="none"
      {...svgProps}
    >
      <title>{title}</title>

      {/* Cloud outline (dashed) — the "not yet connected" storage destination.
          Drawn with currentColor so it inherits the text foreground. */}
      <path
        d="M70 62
           a28 28 0 0 1 54 -8
           a22 22 0 0 1 32 10
           a20 20 0 0 1 -6 39
           H72
           a24 24 0 0 1 -2 -41 Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeDasharray="4 4"
        opacity="0.75"
      />

      {/* Baseline — where the datasource tiles sit. */}
      <line
        x1="32"
        y1="132"
        x2="208"
        y2="132"
        stroke="currentColor"
        strokeWidth="1"
        opacity="0.4"
      />

      {/* Three stacked datasource tiles in primary accent — each tile is
          rounded-sm-ish to echo the dashboard radii ceiling. The middle
          tile is offset slightly to suggest "lattice" rather than a rigid
          stack. */}
      <rect
        x="82"
        y="118"
        width="22"
        height="14"
        rx="2"
        fill="var(--primary)"
        opacity="0.9"
      />
      <rect
        x="109"
        y="118"
        width="22"
        height="14"
        rx="2"
        fill="var(--primary)"
        opacity="0.6"
      />
      <rect
        x="136"
        y="118"
        width="22"
        height="14"
        rx="2"
        fill="var(--primary)"
        opacity="0.35"
      />

      {/* Dotted connector lines from cloud down to the tile baseline,
          suggesting a pending / not-yet-established sync. */}
      <line
        x1="93"
        y1="104"
        x2="93"
        y2="118"
        stroke="currentColor"
        strokeWidth="1"
        strokeDasharray="2 3"
        opacity="0.5"
      />
      <line
        x1="120"
        y1="104"
        x2="120"
        y2="118"
        stroke="currentColor"
        strokeWidth="1"
        strokeDasharray="2 3"
        opacity="0.5"
      />
      <line
        x1="147"
        y1="104"
        x2="147"
        y2="118"
        stroke="currentColor"
        strokeWidth="1"
        strokeDasharray="2 3"
        opacity="0.5"
      />
    </svg>
  );
}
