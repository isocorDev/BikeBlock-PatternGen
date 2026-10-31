# BikeBlock Pattern Generator

A design tool for the laser or waterjet cut brass backplate of a wall-mounted bike showcase. It generates seeded, repeatable line patterns, previews the plate backlit inside its cherry frame, and exports cut-ready files.

Live: https://isocordev.github.io/BikeBlock-PatternGen/

## What it does

Six generators, each seeded so every plate is repeatable:

- **Cells and fills.** Layouts (tumbling blocks, squares, triangles, Voronoi, one field) times fills (parallel lines, concentric bands, open cells). Line direction can be random by seed, alternating, uniform, or flowing along a noise field.
- **Lattice.** Brass straps along traditional line patterns. Japanese kumiko: asanoha (hemp leaf) and kagome (basket weave). Islamic geometric: eight-, six- and four-point stars, built with Hankin's polygons-in-contact method, with an adjustable star angle.
- **Circle packing.** Holes packed as tightly as the spacing allows, sized by soft noise, center outward, side to side, or at random.
- **Game of Life.** A seeded random start run forward N generations; live cells become rounded square holes in a brass grid.
- **Noise field.** Fractal simplex noise, cut as shapes or as constant-width contour bands.
- **Reaction diffusion.** Gray-Scott simulation (coral, labyrinth, fingerprint, spots, worms), cut as shapes or bands.

**Blending.** A second layer (B), edited with the same controls, combines with layer A:

- Crossfade A into B, shaped by a source (side to side, center outward, a band across, or noise).
- Mask: A in one zone, B (or solid brass) in the other, with a brass seam between.
- Combine: cut both, cut where both cut, or A minus B.
- Warp A by noise, like wood grain.
- Grow and shrink A's cuts by a source, for example smaller cuts in the middle where the LEDs are brightest. Growth never goes past the fabrication minimums.

Plus: presets grouped by lineage (geometric, Japanese kumiko, Islamic geometric, organic), blend presets, Explore (nine seed variations at once), design name and edition number, autosave, saved designs, and share links.

## Files

| File | Use |
| --- | --- |
| DXF | Waterjet shop. R12, inches, one closed polyline per cut, arcs as true arcs. Layers `OUTLINE` and `CUTS`. |
| SVG | Laser, Illustrator, Fusion 360. Inches, 1:1. Layers `cut-outline` and `cut-interior`, plus a filled preview layer. |
| PNG | Product render in the frame, or black and white plate. 2400 px. |
| JPG | 1200 px thumbnail. |
| PDF drawing | True 1:1 vector drawing with a title block (name, plate number, pattern, size, material, process, cut length, pierces, open area, seed, design code, date) and a 1 in scale bar to check print scale. |
| PDF certificate | Letter-size certificate of origin for the numbered plate: product render, specs, seed, design code, maker, signature line. |
| Coupon DXF / SVG | A 3, 4 or 6 in square from the middle of the exact plate, to test-cut before the full sheet. Cuts crossing the coupon edge are trimmed and end round, a minimum web from the edge. |
| JSON | Settings only. |

The design code is a short fingerprint of every setting that affects the cut: same code, same plate.

Drop the SVG, DXF, PNG or JSON back onto the app (or use Files, Open a file) to reopen the exact design.

## Fabrication rules

Defaults: 1/8 in brass, waterjet, 18 x 10 in plate. Narrowest brass and narrowest cut are both max(1x thickness, a small floor); sliders cannot go below them.

**Cells, circles and Life** are built as exact convex shapes. Every cut is shrunk by the cutter radius and grown back round, which rounds inside corners and removes slivers. Cuts never touch each other or the border, so the brass is always one piece. No islands are possible.

**Lattices, noise, reaction diffusion and every blend** can make any shape, so they get an explicit repair on a raster (64 to 128 px per inch):

1. Brass thinner than the minimum is removed.
2. Brass enclosed by a cut (an island) is tied to the plate with a straight bridge, or cut away.
3. Cuts thinner than the minimum are closed, which also rounds inside corners.
4. Steps 1 to 3 repeat until they agree, then any remaining thin brass neck is thickened.
5. Outlines are traced from the result's signed distance and simplified.

The Fabrication tab reports bridges added, loose pieces left and spots still under the minimum. In testing, every raster pattern came out with zero loose pieces, and most had no spot narrower than one raster pixel (about 0.01 in) under the minimum. Heavy warps can leave a few spots slightly under (about 0.016 in in testing); the app flags them in red, and wider lines fix them. While you drag sliders the preview is a quick draft; it refines automatically when you stop, and exports always use the refined version.

These rules come from common sheet-cutting guidance. Confirm the final numbers with the shop.

## Develop

```sh
npm install
npm run dev      # local server
npm run build    # type-check and build to dist/
```

The site deploys to GitHub Pages from `main` through `.github/workflows/deploy.yml`. One-time setup: in the repo's Settings, Pages, set Source to "GitHub Actions".

## How the code is organized

- `src/settings.ts` design settings, defaults, fabrication limits, sanitizing.
- `src/layouts.ts` cell layouts, including Voronoi.
- `src/lattice.ts` kumiko and Islamic strap patterns (Hankin's method).
- `src/plate.ts` builds analytic plates: cells and fills, circle packing, Game of Life.
- `src/fields.ts` noise and reaction diffusion, layer masks, blend modes, and the raster repair.
- `src/raster.ts` distance transforms, opening, island bridging, contour tracing.
- `src/noise.ts` seeded simplex noise. `src/rng.ts` seeded hashing and PRNG.
- `src/worker.ts` runs field builds in the background.
- `src/geom.ts` convex polygon clipping and the rounded-polygon shape analytic cuts use.
- `src/render.ts` canvas preview and image renders.
- `src/export.ts` SVG, DXF, PNG with embedded settings, test coupon.
- `src/pdf.ts` hand-written PDF: shop drawing and certificate.
- `src/store.ts` autosave, saved designs, URL encoding.
- `src/main.ts` controls and interaction.

The preview and the exports draw the same geometry, so the screen matches the cut.

## Roadmap

Moire, guilloche, Penrose and flow-line patterns. A bike-aware mask is not planned: only the top tube crosses the opening, and the Calm band blend covers that.
