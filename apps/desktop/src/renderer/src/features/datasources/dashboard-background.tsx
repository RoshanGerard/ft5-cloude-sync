// Dashboard background — asymmetric hexagon-network watermark
// (review-round-2, Task 2). Replaces the earlier tiled CSS watermark so
// the decorative pattern:
//
//   - matches the user's reference: hexagonal outlines with dots at
//     vertices, interconnected by thin lines, clustered densely on the
//     right with a sparse trail of isolated cells running left,
//   - adapts to theme via `currentColor` (the single component renders
//     on both themes — dark stroke on light bg, light stroke on dark
//     bg — without a per-theme duplicate),
//   - stays purely decorative: `aria-hidden`, `pointer-events-none`,
//     no motion, no runtime cost beyond the static SVG parse.
//
// Colour strategy (same contract as empty-datasources.tsx — the literals-
// ban guardrail forbids hex / rgb() / hsl() / oklch() inside feature
// code): strokes and dot fills all resolve to `currentColor`, which the
// consumer supplies by setting `text-foreground` (or any `text-*`) on a
// wrapper. `fill-opacity`/`stroke-opacity` are numeric attributes, not
// colour functions, so they pass the guardrail.
//
// Geometry: pointy-top regular hexagons. For a hex with centre (cx, cy)
// and circumradius r, the six vertices sit at angles 30° + k*60° around
// the centre — precomputed into strings below. A single "size" r == 28
// (SVG units) keeps all hexes uniform; the network *feels* organic
// because the hex positions are hand-placed, not because the shapes
// vary.

import type { SVGProps } from "react";

// Circumradius in SVG units. Chosen so hexes tile at pitch 2r*cos(30°)
// horizontally (~48.5) and 1.5r vertically (42) when the lattice packs.
const HEX_R = 28;

// Hand-placed hex centres. x,y coordinates are SVG user-units within the
// 1200 x 600 viewBox. The right half (x >= 600) carries ~20+ cells in a
// loose honeycomb; the left half trails off with ~8 isolated cells.
//
// Each entry also marks whether the hex is "lit" — a handful of cells
// render with a faint fill as well as the stroke, to suggest active
// nodes in the network. Without lit cells the whole piece reads flat.
type HexCell = { x: number; y: number; lit?: boolean };

const HEX_CELLS: readonly HexCell[] = [
  // Sparse left trail — isolated cells stepping in from the edge.
  { x: 90, y: 220 },
  { x: 180, y: 160 },
  { x: 240, y: 340 },
  { x: 340, y: 120 },
  { x: 400, y: 260 },
  { x: 420, y: 420 },
  { x: 510, y: 180 },
  { x: 540, y: 360 },

  // Right half — denser honeycomb. Two rows offset by half a pitch so
  // adjacent cells share an edge in the classical honeycomb way.
  // Top band (y ~ 80..160).
  { x: 650, y: 120, lit: true },
  { x: 700, y: 80 },
  { x: 750, y: 120 },
  { x: 800, y: 80 },
  { x: 850, y: 120 },
  { x: 900, y: 80, lit: true },
  { x: 950, y: 120 },
  { x: 1000, y: 80 },
  { x: 1050, y: 120 },
  { x: 1100, y: 80 },

  // Middle band (y ~ 220).
  { x: 620, y: 240 },
  { x: 670, y: 200 },
  { x: 720, y: 240, lit: true },
  { x: 770, y: 200 },
  { x: 820, y: 240 },
  { x: 870, y: 200 },
  { x: 920, y: 240 },
  { x: 970, y: 200, lit: true },
  { x: 1020, y: 240 },
  { x: 1070, y: 200 },
  { x: 1120, y: 240 },

  // Lower band (y ~ 360..440).
  { x: 640, y: 380 },
  { x: 700, y: 420, lit: true },
  { x: 760, y: 380 },
  { x: 820, y: 420 },
  { x: 880, y: 380 },
  { x: 940, y: 420 },
  { x: 1000, y: 380, lit: true },
  { x: 1060, y: 420 },
  { x: 1120, y: 380 },

  // Scattered echoes near the bottom-right corner.
  { x: 780, y: 520 },
  { x: 880, y: 540 },
  { x: 1000, y: 520 },
];

function hexPoints(cx: number, cy: number, r: number): string {
  // Pointy-top: first vertex at 12 o'clock (-90°), step by 60°. Rounded
  // to 2 decimals so the SVG serialises compactly and snapshot diffs
  // stay stable.
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (-Math.PI / 2) + (i * Math.PI) / 3;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(" ");
}

// Distance between two cell centres, used to decide which pairs deserve
// a connection line. The honeycomb pitch is roughly 2*r (edge-to-edge
// in the lattice above), so anything under ~65 units is considered a
// neighbour link. Pairs too far apart become disconnected clusters,
// which is the point: sparse left, densely-connected right.
function distance(a: HexCell, b: HexCell): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Compute connection pairs once at module load. Keeping the derivation
// here (rather than hand-listing pairs) means edits to HEX_CELLS
// automatically re-wire the network.
function computeConnections(): ReadonlyArray<readonly [HexCell, HexCell]> {
  const pairs: Array<[HexCell, HexCell]> = [];
  const MAX = 68; // just over the lattice pitch
  for (let i = 0; i < HEX_CELLS.length; i++) {
    for (let j = i + 1; j < HEX_CELLS.length; j++) {
      const a = HEX_CELLS[i]!;
      const b = HEX_CELLS[j]!;
      if (distance(a, b) <= MAX) {
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

const CONNECTIONS = computeConnections();

// Vertex dots: we drop a small filled circle at each hex centre — the
// "node" the network line connects to. Placing dots at every hex vertex
// would be visually busy, so we draw them only at centres of the lit
// cells plus a few manually-chosen anchor points. This keeps the
// overall density in the 10–20% range the review calls for.
const DOT_POSITIONS: ReadonlyArray<{ x: number; y: number }> = [
  // Centres of lit cells are the "active nodes".
  ...HEX_CELLS.filter((c) => c.lit).map(({ x, y }) => ({ x, y })),
  // A handful of standalone anchors along the left trail — these are
  // what draw the eye across from the sparse side to the dense side.
  { x: 90, y: 220 },
  { x: 240, y: 340 },
  { x: 400, y: 260 },
  { x: 540, y: 360 },
];

export type DashboardBackgroundProps = Omit<
  SVGProps<SVGSVGElement>,
  "children" | "viewBox" | "aria-hidden"
>;

export function DashboardBackground(props: DashboardBackgroundProps) {
  const {
    className = "pointer-events-none absolute inset-0 text-foreground",
    preserveAspectRatio = "xMaxYMid slice",
    ...rest
  } = props;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1200 600"
      preserveAspectRatio={preserveAspectRatio}
      aria-hidden="true"
      className={className}
      {...rest}
    >
      {/* Lit cells first (under the strokes) so the subtle fill sits
          behind the outline. fill-opacity is a numeric attribute — not
          a colour function — so the literals-ban guardrail is fine. */}
      {HEX_CELLS.filter((c) => c.lit).map((cell, idx) => (
        <polygon
          key={`lit-${idx}`}
          points={hexPoints(cell.x, cell.y, HEX_R)}
          fill="currentColor"
          fillOpacity="0.04"
          stroke="none"
        />
      ))}

      {/* Connecting lines — drawn next so they pass UNDER the hex
          outlines at every intersection, which reads more cleanly than
          lines on top of strokes. */}
      <g
        stroke="currentColor"
        strokeWidth="0.5"
        strokeOpacity="0.15"
        strokeLinecap="round"
      >
        {CONNECTIONS.map(([a, b], idx) => (
          <line
            key={`conn-${idx}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
          />
        ))}
      </g>

      {/* Hexagon outlines — the primary visual element. strokeWidth is
          just under 1 SVG-unit so the outline reads as a hairline even
          after preserveAspectRatio="slice" crops/scales. */}
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="0.75"
        strokeOpacity="0.20"
        strokeLinejoin="round"
      >
        {HEX_CELLS.map((cell, idx) => (
          <polygon
            key={`hex-${idx}`}
            points={hexPoints(cell.x, cell.y, HEX_R)}
          />
        ))}
      </g>

      {/* Vertex dots — the tiny filled circles that anchor the network
          nodes. A small radius (1.5) keeps them from dominating. */}
      <g fill="currentColor" fillOpacity="0.35" stroke="none">
        {DOT_POSITIONS.map((dot, idx) => (
          <circle
            key={`dot-${idx}`}
            cx={dot.x}
            cy={dot.y}
            r="1.5"
          />
        ))}
      </g>
    </svg>
  );
}
