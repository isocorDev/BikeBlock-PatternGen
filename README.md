# BikeBlock Pattern Generator

A design tool for the laser or waterjet cut brass backplate of a wall-mounted bike showcase. It generates seeded, repeatable line patterns, previews the plate backlit inside its cherry frame, and exports cut-ready files.

Live: https://isocordev.github.io/BikeBlock-PatternGen/

## What it does

- Pattern layouts: tumbling blocks (the reference look), squares, triangles, and one continuous field. Each cell is hatched in one direction, chosen by seed or by rule.
- Live controls for plate size, border, corner radius, mounting holes, cell size, rotation, brass line width, cut gap, seam width and line offset.
- Seeds make every plate repeatable. Explore shows nine seed variations at once.
- Every design has a name and an edition number, used in file names.
- Settings autosave, can be saved by name, travel in the URL, and are embedded in every exported file.

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

Defaults: 1/8 in brass, waterjet, 18 x 10 in plate.

- Narrowest brass and narrowest cut are both max(1x thickness, a small floor). Sliders cannot go below them.
- Every slot is "opened": shrunk by the cutter radius and grown back round. That rounds every inside corner and removes any sliver narrower than the minimum cut.
- Slots never touch each other or the border, so the brass is always one connected piece. No islands are possible with these layouts.
- Open area, cut length and pierce count update live.

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
- `src/layouts.ts` cell layouts.
- `src/plate.ts` builds the plate: cells, hatching, opening, stats.
- `src/geom.ts` convex polygon clipping and the rounded-polygon shape every cut uses.
- `src/render.ts` canvas preview and image renders.
- `src/export.ts` SVG, DXF, PNG with embedded settings.
- `src/store.ts` autosave, saved designs, URL encoding.
- `src/main.ts` controls and interaction.

The preview and the exports draw the same geometry, so the screen matches the cut.

## Roadmap

Field-based patterns (noise, reaction diffusion, Game of Life, circle packing, Voronoi), blending between patterns, bike-aware and light-aware masks, PDF with a title block, and edition certificates.
