# Blopik Map: Pikmin Bloom Decor Finder

An unofficial web app that finds spots where the Pikmin Bloom detector should show
**only one decor type**, so the seedling it finds is guaranteed to be that decor.
Location data comes from OpenStreetMap, served as vector tiles by [OpenFreeMap](https://openfreemap.org).

**Live app:** https://radswouse.github.io/Blopik-Map/ (once GitHub Pages is on)

## How it works

- The game assigns decor by map **cell**. The detector lists the decor types of every
  cell whose centre is within **100 m** of you (Pikipedia, "Detector").
- The app loads OpenFreeMap's z14 vector tiles (OpenMapTiles schema): free, CDN-cached and
  without rate limits. The same tiles draw the base map.
- OpenMapTiles has no `cuisine` tag, so Sushi/Italian/Ramen/Curry/Mexican/Korean use a small
  Overpass lookup, sent only when needed: one request at a time, and 30 s+ back-off on any "busy" answer.
- It works out each cell's decor types and tests points every few metres. Each point
  is coloured by how many *other* types would show alongside your chosen one.
- Green = only your type, so the decor is guaranteed if the map data matches the game.
- **Find nearest** searches outward (0.5 → 3 km) for the closest pure spot with a safety margin.

The cell grid isn't published. The default is **S2 level 17**: about 6 of those cells
fit in the 100 m range, which matches the detector's 6–7 icon limit. The **Calibrate**
tab logs real detector readings and scores 60 model variants against them.

## Files

| Path | What |
|---|---|
| `index.html` | The whole app (built file that GitHub Pages serves) |
| `src/engine.js` | Decor ↔ OSM tag table, MVT decoder, cell grids, detector, isolation + nearest-spot logic |
| `src/vector.js` | OpenFreeMap tile loading + base-map renderer |
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
