// Forti5 brand logo — real geometry (review-round-2, Task 1).
//
// The round-1 component was a simplified chevron-and-pentagon mark. The
// user supplied the authoritative SVG (`dpc_glyph_dark.svg`) — a central
// small pentagon plus 5 outer petals in a 174.16 x 166.81 viewBox — and
// this component embeds those exact polygon points.
//
// Theme-colour strategy (matches the literals-ban guardrail — no hex,
// rgb, hsl, or oklch functions allowed in feature code):
//   - the 5 outer petals fill with `var(--brand-primary)` (theme-
//     invariant crimson, declared in globals.css at both :root and .dark
//     scope),
//   - the central pentagon fills with `var(--background)` so it reads
//     as a theme-reactive "hole in the middle" — near-white on light
//     theme, warm-near-black on dark theme, mirroring the original
//     brand-mark's black dot on crimson petals.
//
// The viewBox is no longer square (1.044:1), so rendering with
// `width={size} height={size}` intentionally letterboxes inside the
// bounding box under the SVG default `preserveAspectRatio`. At 28px
// chrome size the letterbox is imperceptible.

import type { SVGProps } from "react";

export interface Forti5LogoProps extends Omit<SVGProps<SVGSVGElement>, "width" | "height"> {
  /**
   * Pixel size for both width and height. The viewBox itself is
   * slightly taller than wide (174.16 x 166.81); the SVG
   * preserveAspectRatio ("xMidYMid meet" by default) letterboxes rather
   * than distorts. Defaults to 28.
   */
  size?: number;
}

// Exact polygon points from `dpc_glyph_dark.svg`. The first entry is the
// small central pentagon; the 5 remaining entries are the outer petals
// in the same DOM order as the source file (so the mark reads visually
// identical to the vendor PNG).
const CENTER_PENTAGON_POINTS =
  "74.52 87.6 86.87 78.51 99.64 87.79 94.8 103.07 79.53 103.17";

const PETAL_POINTS: readonly string[] = [
  // Top petal (apex toward the top-right).
  "120.25 24.18 86.97 0 49.63 28.19 106 69.14 120.25 24.18",
  // Upper-right petal (warms the right edge).
  "135.71 36.84 114.76 102.95 161.42 102.66 174.16 63.54 135.71 36.84",
  // Lower-left petal (anchors the left side).
  "20.48 127.66 33.14 166.81 80.48 166.16 59.19 99.2 20.48 127.66",
  // Upper-left petal.
  "33.45 39.38 0 63.32 15.43 108.38 71.55 67.06 33.45 39.38",
  // Lower-right petal.
  "100.21 166.05 141.35 166.46 155.56 120.76 85.94 121.7 100.21 166.05",
];

export function Forti5Logo({
  size = 28,
  role = "img",
  "aria-label": ariaLabel = "FT5 Unified Cloud Sync",
  ...rest
}: Forti5LogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 174.16 166.81"
      width={size}
      height={size}
      role={role}
      aria-label={ariaLabel}
      data-testid="forti5-logo"
      {...rest}
    >
      {/* Five outer petals in theme-invariant brand crimson. Grouping under
          a <g fill> avoids repeating the attribute per polygon. */}
      <g fill="var(--brand-primary)">
        {PETAL_POINTS.map((points, idx) => (
          <polygon key={idx} points={points} />
        ))}
      </g>
      {/* Central pentagon in the theme background colour — reads as a
          contrasting "hole" that flips with the theme (near-white on
          light, warm-near-black on dark). */}
      <polygon
        points={CENTER_PENTAGON_POINTS}
        fill="var(--background)"
      />
    </svg>
  );
}
