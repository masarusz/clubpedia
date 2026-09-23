#!/usr/bin/env python3
"""Build deterministic, metadata-free player portraits from cached originals."""

import argparse
import json
import os
from pathlib import Path
import tempfile

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]


def crop_box(image_width, image_height, face):
    x, y, width, height = face
    fx = x * image_width
    fw = width * image_width
    fh = height * image_height
    fy = (1 - y - height) * image_height
    crop_height = min(image_height, 3.0 * fh)
    crop_width = 0.75 * crop_height
    if crop_width > image_width:
        crop_width = image_width
        crop_height = crop_width * 4 / 3
    left = fx + fw / 2 - crop_width / 2
    top = fy - 0.9 * fh
    left = min(max(0.0, left), image_width - crop_width)
    top = min(max(0.0, top), image_height - crop_height)
    return left, top, left + crop_width, top + crop_height


def manifest_entries(path, exclusion_path):
    manifest = json.loads(path.read_text(encoding="utf-8"))
    exclusions = json.loads(exclusion_path.read_text(encoding="utf-8")) if exclusion_path.is_file() else {}
    entries = []
    for player_id, photo in manifest.items():
        if player_id == "_about" or player_id in exclusions:
            continue
        face = photo.get("face")
        if (not isinstance(face, list) or len(face) != 4
                or any(not isinstance(value, (int, float)) or value < 0 or value > 1 for value in face)
                or face[2] <= 0 or face[3] <= 0 or face[0] + face[2] > 1 or face[1] + face[3] > 1):
            raise ValueError(f"invalid face box for {player_id}")
        entries.append((player_id, photo))
    return sorted(entries)


def build(manifest_path, exclusion_path, original_root, output_root):
    entries = manifest_entries(manifest_path, exclusion_path)
    output_root.mkdir(parents=True, exist_ok=True)
    wanted = {player_id for player_id, _photo in entries}
    for stale in output_root.glob("*.webp"):
        if stale.stem not in wanted:
            stale.unlink()

    for player_id, photo in entries:
        source = original_root / f"{player_id}.jpg"
        if not source.is_file():
            raise FileNotFoundError(f"missing photo original {player_id}: {source}")
        with Image.open(source) as image:
            if list(image.size) != photo.get("size"):
                raise ValueError(f"photo size mismatch for {player_id}: {image.size} != {photo.get('size')}")
            portrait = image.convert("RGB").crop(crop_box(image.width, image.height, photo["face"]))
            portrait = portrait.resize((240, 320), Image.Resampling.LANCZOS)
            descriptor, temporary = tempfile.mkstemp(prefix=f".{player_id}-", suffix=".tmp", dir=output_root)
            os.close(descriptor)
            try:
                portrait.save(
                    temporary,
                    format="WEBP",
                    quality=72,
                    method=6,
                    exif=b"",
                    xmp=b"",
                    icc_profile=b"",
                )
                os.chmod(temporary, 0o644)
                os.replace(temporary, output_root / f"{player_id}.webp")
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=ROOT / "curated/photos.json")
    parser.add_argument("--exclusions", type=Path, default=ROOT / "curated/photo-exclusions.json")
    parser.add_argument("--orig", type=Path, default=ROOT / ".cache/sources/photos/orig")
    parser.add_argument("--out", type=Path, default=ROOT / "public/assets/players")
    args = parser.parse_args()
    build(args.manifest, args.exclusions, args.orig, args.out)


if __name__ == "__main__":
    main()
