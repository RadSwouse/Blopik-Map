"""Inline src/engine.js, src/map.js and src/app.js into src/page.html -> index.html."""
import pathlib
root = pathlib.Path(__file__).parent
page = (root / 'src/page.html').read_text()
for ph, f in [('/*ENGINE*/', 'engine.js'), ('/*MAP*/', 'map.js'), ('/*APP*/', 'app.js')]:
    js = (root / 'src' / f).read_text()
    assert '</script' not in js.lower(), f
    page = page.replace(ph, js)
(root / 'index.html').write_text(page)
print('built index.html', len(page) // 1024, 'KB')
