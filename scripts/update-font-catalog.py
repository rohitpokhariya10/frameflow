"""Refresh metadata only from Google's public catalog. No secrets or font binaries. Run manually, review diff."""
import json
from pathlib import Path
from urllib.request import urlopen
from datetime import date
raw = urlopen('https://fonts.google.com/metadata/fonts', timeout=40).read().decode()
data = json.loads(raw[raw.index('{'):])['familyMetadataList']
rows = [[f['family'], f['category'], sorted({int(w.rstrip('i')) for w in f['fonts'] if not w.endswith('i')}) or [400],
         'devanagari' in f['subsets'], any(w.endswith('i') for w in f['fonts'])] for f in sorted(data, key=lambda f: f['family'])]
assert len(rows) > 1500
Path('shared/src/fonts/googleFontsCatalog.ts').write_text(
    f'/** Google Fonts public metadata snapshot, {date.today()}. Update with scripts/update-font-catalog.py. Metadata only, no font binaries. */\n'
    'export const GOOGLE_FONT_ROWS: readonly (readonly [string, string, readonly number[], boolean, boolean])[] = '
    + json.dumps(rows, ensure_ascii=False, separators=(',', ':')) + ';\n')
print(f'Wrote {len(rows)} families. Verify recommendations before committing.')
