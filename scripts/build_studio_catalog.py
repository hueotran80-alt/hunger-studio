#!/usr/bin/env python3
"""
Build categorized Studio Asset Catalog (`assets/library/studio-catalog.json`)
by fetching live metadata from Poly Haven (100% CC0-1.0, or reusing existing
Poly Haven entries with --local-only) and inspecting embedded license/author
metadata in built-in local `.glb`/`.vrm` assets in `assets/` and `models/`.

Zero Epic/Fab/Megascans bytes are included or linked here (see FAB_CATALOG in
`js/ui/asset-library-sources.js`).
"""
import argparse
import json
import re
import struct
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = ROOT / 'assets' / 'library' / 'studio-catalog.json'
POLYHAVEN_ASSETS_API = 'https://api.polyhaven.com/assets'

VEGETATION_CATS = {'plants', 'trees', 'grass', 'flowers', 'ground cover', 'potted plants', 'succulent'}
ENV_MODEL_CATS = {'rocks', 'nature', 'terrain'}
ARCH_MODEL_CATS = {'buildings', 'structures'}
CHAR_MODEL_CATS = {'creature', 'rigged'}

KNOWN_LOCAL_LICENSES = {
    'Mannequin_CC0.glb': {
        'license': 'CC0-1.0',
        'author': 'Web Blender Studio',
        'source': 'https://creativecommons.org/publicdomain/zero/1.0/',
        'commercialSafe': True,
    },
    'Bot_CC0.glb': {
        'license': 'CC0-1.0',
        'author': 'Web Blender Studio',
        'source': 'https://creativecommons.org/publicdomain/zero/1.0/',
        'commercialSafe': True,
    },
    'CesiumMan.glb': {
        'license': 'CC-BY-4.0',
        'author': 'Analytical Graphics, Inc. (Khronos glTF Sample Assets)',
        'source': 'https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CesiumMan',
        'commercialSafe': True,
    },
    'LeePerrySmith.glb': {
        'license': 'CC-BY-3.0',
        'author': 'Lee Perry-Smith (Infinite-Realities)',
        'source': 'https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf/LeePerrySmith',
        'commercialSafe': True,
    },
    'Michelle.glb': {
        'license': 'Mixamo-EULA-Dev-Only',
        'author': 'Adobe Mixamo',
        'source': 'https://www.mixamo.com/',
        'commercialSafe': False,
    },
    'Soldier.glb': {
        'license': 'Mixamo-EULA-Dev-Only',
        'author': 'Adobe Mixamo',
        'source': 'https://www.mixamo.com/',
        'commercialSafe': False,
    },
    'Soldier_Human_Rigged.glb': {
        'license': 'Mixamo-EULA-Dev-Only',
        'author': 'Adobe Mixamo',
        'source': 'https://www.mixamo.com/',
        'commercialSafe': False,
    },
}


def read_glb_asset_meta(path: Path):
    """Extract glTF `asset` metadata (`copyright`, `extras`) from a binary .glb."""
    if path.suffix.lower() != '.glb':
        return {}
    try:
        with path.open('rb') as handle:
            header = handle.read(20)
            if len(header) < 20 or header[:4] != b'glTF':
                return {}
            json_len = struct.unpack('<I', header[12:16])[0]
            if json_len <= 0 or json_len > 8 * 1024 * 1024:
                return {}
            data = json.loads(handle.read(json_len).decode('utf-8'))
            return data.get('asset') if isinstance(data, dict) else {}
    except Exception:
        return {}


def normalize_license_code(raw_license: str) -> str:
    text = str(raw_license or '').strip()
    if not text:
        return ''
    match = re.match(r'^(CC0-1\.0|CC-BY-(?:NC-)?(?:SA-)?\d+\.\d+)', text, re.IGNORECASE)
    if match:
        return match.group(1).upper()
    return text.split('(', 1)[0].strip()


def resolve_local_provenance(path: Path):
    if path.name in KNOWN_LOCAL_LICENSES:
        return dict(KNOWN_LOCAL_LICENSES[path.name])

    asset = read_glb_asset_meta(path) or {}
    copyright_str = str(asset.get('copyright') or '').strip()
    extras = asset.get('extras') if isinstance(asset.get('extras'), dict) else {}
    raw_license = str(extras.get('license') or '').strip()
    author = str(extras.get('author') or '').strip()
    source = str(extras.get('source') or '').strip()

    if 'ready player me' in copyright_str.lower():
        return {
            'license': 'ReadyPlayerMe-Terms-Dev-Only',
            'author': 'Ready Player Me',
            'source': 'https://readyplayer.me/terms',
            'commercialSafe': False,
        }

    if raw_license:
        code = normalize_license_code(raw_license)
        is_nc = 'nc' in code.lower()
        return {
            'license': code,
            'author': author or 'Sketchfab Creator',
            'source': source,
            'commercialSafe': not is_nc,
        }

    if 'cc0' in copyright_str.lower():
        return {
            'license': 'CC0-1.0',
            'author': author or copyright_str,
            'source': source,
            'commercialSafe': True,
        }

    return {
        'license': 'Unverified-Dev-Only',
        'author': author or copyright_str or 'Unknown (Dev-Only)',
        'source': source,
        'commercialSafe': False,
    }


def classify_polyhaven(item_type, cats, tags):
    cat_set = {str(c).strip().lower() for c in (cats or [])}
    tag_set = {str(t).strip().lower() for t in (tags or [])}
    combined = cat_set | tag_set

    if item_type == 1:
        return 'materials'
    if item_type == 0:
        return 'environments'
    if cat_set & VEGETATION_CATS or combined & {'tree', 'fern', 'bush', 'shrub', 'grass', 'flower', 'foliage', 'moss', 'ivy', 'plant'}:
        return 'vegetation'
    if cat_set & ENV_MODEL_CATS or combined & {'rock', 'boulder', 'cliff', 'stone'}:
        return 'environments'
    if cat_set & ARCH_MODEL_CATS or combined & {'building', 'house', 'bridge', 'wall', 'pillar', 'arch', 'cathedral', 'gate'}:
        return 'architecture'
    if cat_set & CHAR_MODEL_CATS or 'character' in combined:
        return 'characters'
    return 'props'


def build_local_studio_items():
    items = []

    def append_item(p: Path, *, item_id: str, name: str, category: str, url: str, extra_tags=(), thumb: str = ''):
        prov = resolve_local_provenance(p)
        tags = ['studio', *extra_tags, p.stem.lower()]
        if prov['license'].upper().startswith('CC-BY') and 'attribution' not in tags:
            tags.append('attribution')
        entry = {
            'id': item_id,
            'name': name,
            'kind': 'studio',
            'studioCategory': category,
            'url': url,
            'ext': p.suffix.lstrip('.').lower(),
            'license': prov['license'],
            'author': prov['author'],
            'commercialSafe': bool(prov['commercialSafe']),
            'source': 'local-studio',
            'tags': tags,
            'sizeBytes': p.stat().st_size,
        }
        if prov.get('source'):
            entry['sourceUrl'] = prov['source']
        if thumb:
            entry['thumb'] = thumb
        items.append(entry)

    # Built-in environments
    env_dir = ROOT / 'assets' / 'environments'
    if env_dir.is_dir():
        for p in sorted(env_dir.iterdir()):
            if p.suffix.lower() in ('.glb', '.gltf'):
                stem = p.stem.replace('_', ' ')
                cat = 'environments' if ('environment' in p.stem.lower() or 'gallery' in p.stem.lower()) else 'architecture'
                append_item(
                    p,
                    item_id=f'studio_env_{p.stem.lower()}',
                    name=stem,
                    category=cat,
                    url=f'/assets/environments/{p.name}',
                    extra_tags=('environment', 'architecture'),
                )

    # Built-in characters
    char_dir = ROOT / 'assets' / 'characters'
    if char_dir.is_dir():
        previews = {
            p.stem.lower(): f'/assets/characters/{p.name}'
            for p in char_dir.iterdir()
            if p.suffix.lower() in ('.png', '.jpg', '.jpeg')
        }
        for p in sorted(char_dir.iterdir()):
            if p.suffix.lower() not in ('.glb', '.vrm'):
                continue
            stem_key = p.stem.lower()
            preview = previews.get(f'preview_{stem_key}') or previews.get(stem_key) or ''
            label = f"{p.stem.replace('_', ' ')} ({p.suffix.upper().lstrip('.')})"
            append_item(
                p,
                item_id=f'studio_char_{stem_key}_{p.suffix.lstrip(".").lower()}',
                name=label,
                category='characters',
                url=f'/assets/characters/{p.name}',
                extra_tags=('character', p.suffix.lstrip('.').lower()),
                thumb=preview,
            )

    # Core flagship models in models/ (CC0 first, CC-BY attributed, legacy dev-only marked)
    for name in ('Mannequin_CC0.glb', 'Bot_CC0.glb', 'LeePerrySmith.glb', 'Michelle.glb', 'Soldier_Human_Rigged.glb'):
        p = ROOT / 'models' / name
        if p.is_file():
            append_item(
                p,
                item_id=f'studio_model_{p.stem.lower()}',
                name=p.stem.replace('_', ' '),
                category='characters',
                url=f'/models/{p.name}',
                extra_tags=('character', 'rigged'),
            )
    return items


def fetch_polyhaven_items():
    req = urllib.request.Request(POLYHAVEN_ASSETS_API, headers={'User-Agent': 'web-blender-studio'})
    raw = json.loads(urllib.request.urlopen(req, timeout=30).read().decode('utf-8'))

    type_map = {0: 'hdri', 1: 'texture', 2: 'model'}
    items = []
    sorted_entries = sorted(
        raw.items(),
        key=lambda kv: int(kv[1].get('download_count') or 0),
        reverse=True,
    )
    for slug, info in sorted_entries:
        item_type = info.get('type')
        ph_type = type_map.get(item_type)
        if not ph_type:
            continue
        cats = info.get('categories') or []
        tags = info.get('tags') or []
        authors_dict = info.get('authors') or {}
        author = ', '.join(list(authors_dict.keys())[:2]) or 'Poly Haven'
        studio_cat = classify_polyhaven(item_type, cats, tags)

        merged_tags = []
        seen = set()
        for t in [ph_type, studio_cat, 'cc0', *cats[:6], *tags[:6]]:
            clean = str(t).strip().lower()
            if clean and clean not in seen:
                seen.add(clean)
                merged_tags.append(clean)

        items.append({
            'id': f'ph_{ph_type}_{slug}',
            'polyhavenId': slug,
            'phType': ph_type,
            'name': str(info.get('name') or slug),
            'kind': 'online',
            'studioCategory': studio_cat,
            'license': 'CC0-1.0',
            'author': author,
            'commercialSafe': True,
            'source': 'polyhaven',
            'thumb': f'https://cdn.polyhaven.com/asset_img/thumbs/{slug}.png?width=256&height=256',
            'tags': merged_tags,
            'downloads': int(info.get('download_count') or 0),
        })
    return items


def load_existing_online_items():
    if not OUT_PATH.is_file():
        return []
    existing = json.loads(OUT_PATH.read_text(encoding='utf-8'))
    return [it for it in (existing.get('items') or []) if it.get('kind') == 'online']


def main():
    parser = argparse.ArgumentParser(description='Build Web Blender Studio asset catalog')
    parser.add_argument('--local-only', action='store_true', help='Reuse existing Poly Haven entries without network')
    args = parser.parse_args()

    local_items = build_local_studio_items()
    if args.local_only:
        ph_items = load_existing_online_items()
        if not ph_items:
            ph_items = fetch_polyhaven_items()
    else:
        try:
            ph_items = fetch_polyhaven_items()
        except Exception:
            ph_items = load_existing_online_items()

    cat_counts = {}
    for it in [*local_items, *ph_items]:
        c = it['studioCategory']
        cat_counts[c] = cat_counts.get(c, 0) + 1

    payload = {
        'version': 3,
        'note': 'Categorized Studio Catalog (Poly Haven CC0-1.0 + Verified Attribution / Dev-Only Local Assets). No Epic/Fab bytes.',
        'counts': {
            'localStudio': len(local_items),
            'polyhavenCC0': len(ph_items),
            'total': len(local_items) + len(ph_items),
            'byCategory': cat_counts,
        },
        'items': [*local_items, *ph_items],
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(json.dumps({
        'written': str(OUT_PATH),
        'bytes': OUT_PATH.stat().st_size,
        'counts': payload['counts'],
        'commercialSafeLocal': [i['url'] for i in local_items if i.get('commercialSafe')],
        'excludedLocal': [(i['url'], i['license']) for i in local_items if not i.get('commercialSafe')],
    }, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
