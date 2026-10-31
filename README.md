# BikeBlock Pattern Generator

A design tool for the laser or waterjet cut brass backplate of a wall-mounted bike showcase. It generates seeded, repeatable line patterns, previews the plate backlit inside its cherry frame, and exports cut-ready files.

Live: https://isocordev.github.io/BikeBlock-PatternGen/

## What it does

Five generators, each seeded so every plate is repeatable:

- **Cells and fills.** Layouts (tumbling blocks, squares, triangles, Voronoi, one field) times fills (parallel lines, concentric bands, open cells). The reference look is tumbling blocks with parallel lines.
- **Circle packing.** Holes packed as tightly as the spacing allows, sized by soft noise, center outward, side to side, or at random.
- **Game of Life.** A seeded random start run forward N generations; live cells become rounded square holes in a brass grid.
- **Noise field.** Fractal simplex noise, cut as shapes or as constant-width contour bands.
- **Reaction diffusion.** Gray-Scott simulation (coral, labyrinth, fingerprint, spots, worms), cut as shapes or bands.

Plus: twelve presets, live controls that show only what applies to the chosen generator, Explore (nine seed variations at once), design name and edition number, autosave, saved designs, and share links.

## Files

| File | Use |
| --- | --- |
| DXF | Waterjet shop. R12, inches, one closed polyline per cut, arcs as true arcs. Layers `OUTLINE` and `CUTS`. |
| SVG | Laser, Illustrator, Fusion 360. Inches, 1:1. Layers `cut-outline` and `cut-interior`, plus a filled preview layer. |
| PNG | Product render in the frame, or black and white plate. 2400 px. |
| JPG | 1200 px thumbnail. |
| JSON | Settings only. |

Drop any of these files back onto the app (or use Files, Open a file) to reopen the exact design.

## Fabrication rules

Defaults: 1/8 in brass, waterjet, 18 x 10 in plate. Narrowest brass and narrowest cut are both max(1x thickness, a small floor); sliders cannot go below them.

**Cells, circles and Life** are built as exact convex shapes. Every cut is shrunk by the cutter radius and grown back round, which rounds inside corners and removes slivers. Cuts never touch each other or the border, so the brass is always one piece. No islands are possible.

**Noise and reaction diffusion** can make any shape, so they get an explicit repair on a raster (64 to 128 px per inch):

1. Brass thinner than the minimum is removed.
2. Brass enclosed by a cut (an island) is tied to the plate with a straight bridge, or cut away.
3. Cuts thinner than the minimum are closed, which also rounds inside corners.
4. Steps 1 to 3 repeat until they agree, then any remaining thin brass neck is thickened.
5. Outlines are traced from the result's signed distance and simplified.

The Fabrication tab reports bridges added, loose pieces left and spots still under the minimum. In testing, every field pattern came out with zero loose pieces, and measured widths were within one raster pixel (about 0.01 in) of the minimum. While you drag sliders the preview is a quick draft; it refines automatically when you stop, and exports always use the refined version.

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
- `src/plate.ts` builds analytic plates: cells and fills, circle packing, Game of Life.
- `src/fields.ts` noise and reaction diffusion, with the raster repair.
- `src/raster.ts` distance transforms, opening, island bridging, contour tracing.
- `src/noise.ts` seeded simplex noise. `src/rng.ts` seeded hashing and PRNG.
- `src/worker.ts` runs field builds in the background.
- `src/geom.ts` convex polygon clipping and the rounded-polygon shape analytic cuts use.
- `src/render.ts` canvas preview and image renders.
- `src/export.ts` SVG, DXF, PNG with embedded settings.
- `src/store.ts` autosave, saved designs, URL encoding.
- `src/main.ts` controls and interaction.

The preview and the exports draw the same geometry, so the screen matches the cut.

## Roadmap

Blending between patterns (layout x fill, crossfade, mask, warp, modulate, steer), bike-aware and light-aware masks, PDF with a title block, and edition certificates.
