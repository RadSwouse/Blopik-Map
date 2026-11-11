# Blopik Map: Pikmin Bloom Decor Finder

An unofficial web app that finds spots where the Pikmin Bloom detector should show
**only one decor type**, so the seedling it finds is guaranteed to be that decor.
Location data comes from OpenStreetMap through the Overpass API.

**Live app:** https://radswouse.github.io/Blopik-Map/ (once GitHub Pages is on)

## How it works

- The game assigns decor by map **cell**. The detector lists the decor types of every
  cell whose centre is within **100 m** of you (Pikipedia, "Detector").
- The app downloads OSM places for ~1 km tiles with one combined query per tile, using
  several Overpass servers with automatic fallback. Results are cached in the browser.
- It works out each cell's decor types and tests points every few metres. Each point
  is coloured by how many *other* types would show alongside your chosen one.
- Green = only your type, so the decor is guaranteed if the map data matches the game.

The cell grid isn't published. The default is **S2 level 17**: about 6 of those cells
fit in the 100 m range, which matches the detector's 6–7 icon limit. The **Calibrate**
tab logs real detector readings and scores 60 model variants against them.

## Files

| Path | What |
|---|---|
| `index.html` | The whole app (built file that GitHub Pages serves) |
| `src/engine.js` | Decor ↔ OSM tag table, cell grids, Overpass query/parse, detector + isolation logic |
| `src/map.js` | Small dependency-free canvas map |
| `src/app.js`, `src/page.html` | UI |
| `build.py` | Inlines `src/*` into `index.html` |
| `test/` | Engine unit tests and a headless-browser UI test on a synthetic map |

Edit files in `src/`, then run `python3 build.py`. Tests: `node test/engine.test.js`.

## Caveats

- The game also uses Foursquare data, which isn't freely available, and it refreshes
  its own map copy only occasionally (most recently October 2026).
- The tag mapping follows Pikipedia's *Decor Pikmin* page. To change it, edit
  `CATEGORIES` in `src/engine.js`.

Map data © OpenStreetMap contributors (ODbL). Not affiliated with Niantic or Nintendo.
