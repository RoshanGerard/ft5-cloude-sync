// Forti5 brand logo — Decision 14 (review-round-1).
//
// A 5-fold rotationally-symmetric pentagonal mark. Five crimson chevron
// wedges radiate from a small central pentagon. The geometry is a
// simplified-but-faithful interpretation of the original brand mark:
//   - outer chevron ring anchors "Forti(ve)5" — the 5-count is the
//     load-bearing brand signal;
//   - central pentagon sits in the foreground colour so it reads as a
//     contrasting "hole" rather than a red blob.
//
// Colour strategy (matches empty-datasources.tsx — feature code cannot
// emit oklch/hsl/rgb literals per the literals-ban guardrail):
//   - Chevrons fill with `var(--brand-primary)` (theme-invariant crimson,
//     declared in globals.css for both :root and .dark).
//   - Central pentagon fills with `var(--foreground)`, so on dark mode
//     it's the warm off-white, and on light mode it's the slate-black.
//     The visual intent is "contrasts with the chevrons," which both
//     themes satisfy.
//
// Default size is 28px (the chrome-iconography size from Decision 8's
// revised visual direction: 18px in chrome, with the logo sized up to
// match a lowercase-x-height "product name" word typeset alongside).

import type { SVGProps } from "react";

export interface Forti5LogoProps extends Omit<SVGProps<SVGSVGElement>, "width" | "height"> {
  /**
   * Pixel size for both width and height (the mark is square). Defaults to 28.
   */
  size?: number;
}

// Geometry is authored in a 100-unit viewBox centered at (50, 50) so scaling
// to any render size is a single `width`/`height` attribute change.
const CENTER = 50;

// Outer chevron: a triangular wedge with its apex pointing toward the center,
// sized so five copies around the ring meet edge-to-edge at the boundary.
// Authored once at rotation 0° (apex pointing up toward center from below),
// then rotated 5 times via SVG <g transform="rotate(…)"> wrappers.
//
// The specific point set was hand-tuned to:
//   - leave ~4 units of gap at the center (so the central pentagon shows
//     through),
//   - span a ~72° arc at the outer rim (so all 5 chevrons pack around 360°),
//   - read as a "wedge" not a "triangle" — the base is slightly concave so
//     adjacent chevrons kiss rather than overlap.
//
// Apex at (50, 14): ~36 units from center along +y (after rotation, this
//   becomes the outward tip).
// Base points at (32, 50) and (68, 50): the wide end, 18 units either side
//   of the vertical axis.
// Inner cut at (50, 46): pulls the base inward slightly so the central
//   pentagon has breathing room.
const CHEVRON_PATH = "M50 14 L32 50 L50 46 L68 50 Z";

// Central pentagon. Authored as an explicit five-point polygon centered at
// (50, 50). Radius 7 units — just big enough to read as a discrete central
// element at 28px render size without crowding the chevron apexes.
function pentagonPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 5; i++) {
    // Top-pointing pentagon: first vertex at 12 o'clock, subsequent vertices
    // rotated 72° clockwise.
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    // Keep 3 significant digits to stabilise snapshot diffs.
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(" ");
}

export function Forti5Logo({
  size = 28,
  role = "img",
  "aria-label": ariaLabel = "FT5 Unified Cloud Sync",
  ...rest
}: Forti5LogoProps) {
  const rotations = [0, 72, 144, 216, 288];
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role={role}
      aria-label={ariaLabel}
      data-testid="forti5-logo"
      {...rest}
    >
      {/* Five crimson chevrons at 72° spacing — 5-fold rotational symmetry. */}
      <g fill="var(--brand-primary)">
        {rotations.map((deg) => (
          <path
            key={deg}
            d={CHEVRON_PATH}
            transform={`rotate(${deg} ${CENTER} ${CENTER})`}
          />
        ))}
      </g>
      {/* Central pentagon in the foreground colour — reads as a contrasting
          "well" at the pinwheel's hub. Theme-reactive via --foreground. */}
      <polygon
        points={pentagonPoints(CENTER, CENTER, 7)}
        fill="var(--foreground)"
      />
    </svg>
  );
}
