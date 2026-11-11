"""Build index.html: inline src/*.js and icons/*.webp into src/page.html."""
import base64, json, pathlib
root = pathlib.Path(__file__).parent
page = (root / 'src/page.html').read_text()
icons = {f.stem: 'data:image/webp;base64,' + base64.b64encode(f.read_bytes()).decode()
         for f in sorted((root / 'icons').glob('*.webp'))}
page = page.replace('/*ICONS*/', 'window.PB_ICONS = ' + json.dumps(icons) + ';')
for ph, f in [('/*ENGINE*/', 'engine.js'), ('/*VECTOR*/', 'vector.js'), ('/*MAP*/', 'map.js'), ('/*APP*/', 'app.js')]:
    js = (root / 'src' / f).read_text()
    assert '</script' not in js.lower(), f
    page = page.replace(ph, js)
(root / 'index.html').write_text(page)
print('built index.html', len(page) // 1024, 'KB with', len(icons), 'icons')
