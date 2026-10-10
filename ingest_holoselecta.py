#!/usr/bin/env python3
"""Ingest the HoloSelecta zip into the existing YOLO dataset.

Reads the VOC-annotated zip in cv-ml-core/data/New_data, converts each XML to a
YOLO label file, writes image + label into yolo-dataset/images|labels/train with
a ``holo_`` filename prefix, and extends dataset.yaml with the new classes
(existing class ids are preserved, new classes are appended alphabetically).

Usage:
  python ingest_holoselecta.py --zip "cv-ml-core/data/New_data/FinalDataset-20200127T164214Z-001(1).zip"

Safe to re-run: files are overwritten in place. Follow up with
``python prepare_dataset.py`` to rebuild the stratified train/val split.
"""

import argparse
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

import yaml

IMG_EXTS = (".jpg", ".jpeg", ".png", ".bmp", ".webp")
PREFIX = "holo_"


def parse_args():
    p = argparse.ArgumentParser(description="Convert HoloSelecta VOC zip to YOLO and merge it in.")
    p.add_argument(
        "--zip",
        default="cv-ml-core/data/New_data/FinalDataset-20200127T164214Z-001(1).zip",
        help="Source zip with VOC XML + images.",
    )
    p.add_argument("--dest", default="cv-ml-core/data/yolo-dataset", help="YOLO dataset root.")
    p.add_argument("--data", default="cv-ml-core/data/dataset.yaml", help="dataset.yaml path.")
    p.add_argument("--dry-run", action="store_true", help="Report what would change, write nothing.")
    return p.parse_args()


def normalize_class(raw: str) -> str:
    """Collapse HoloSelecta SKU strings into a short, stable class name.

    Source names look like ``coke__flasche_50__54491472`` or
    ``redbull_light__33__90162800#``; trailing barcodes, duplicate underscores
    and annotation-round typos are dropped so variants of the same product
    land on one class.
    """
    name = raw.strip().rstrip("_#").rstrip("_")
    prev = None
    while prev != name:
        prev = name
        name = re.sub(r"_\d{8,}$", "", name)
    parts = [p.strip("_") for p in name.split("__") if p.strip("_")]
    cleaned = "_".join(parts[:2]).strip("_")
    return cleaned or raw.strip() or "unknown"


def index_zip(zf: zipfile.ZipFile):
    xml_entries, images = [], {}
    for name in zf.namelist():
        if name.endswith("/"):
            continue
        low = name.lower()
        if low.endswith(".xml"):
            xml_entries.append(name)
        elif low.endswith(IMG_EXTS):
            images.setdefault(Path(name).stem.lower(), name)
    return sorted(xml_entries), images


def object_names(root: ET.Element):
    return [obj.findtext("name") or "" for obj in root.findall("object")]


def convert_boxes(root: ET.Element, width: int, height: int, class_ids: dict):
    rows, dropped = [], 0
    for obj in root.findall("object"):
        raw = (obj.findtext("name") or "").strip()
        cls = normalize_class(raw)
        if cls not in class_ids:
            dropped += 1
            continue
        box = obj.find("bndbox")
        if box is None:
            dropped += 1
            continue
        vals = [float(box.findtext(k, "0")) for k in ("xmin", "ymin", "xmax", "ymax")]
        xmin, ymin, xmax, ymax = vals
        if xmin > xmax:
            xmin, xmax = xmax, xmin
        if ymin > ymax:
            ymin, ymax = ymax, ymin
        xmin, xmax = max(0.0, xmin), min(float(width), xmax)
        ymin, ymax = max(0.0, ymin), min(float(height), ymax)
        bw, bh = xmax - xmin, ymax - ymin
        if bw <= 1 or bh <= 1 or width <= 0 or height <= 0:
            dropped += 1
            continue
        cx = (xmin + xmax) / 2.0 / width
        cy = (ymin + ymax) / 2.0 / height
        rows.append(
            f"{class_ids[cls]} {cx:.6f} {cy:.6f} {bw / width:.6f} {bh / height:.6f}"
        )
    return rows, dropped


def update_data_yaml(path: Path, merged_names: dict, dry_run: bool):
    cfg = yaml.safe_load(path.read_text()) if path.exists() else {}
    cfg["names"] = {int(k): v for k, v in sorted(merged_names.items())}
    if not dry_run:
        path.write_text(
            yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True, default_flow_style=False)
        )


def main():
    args = parse_args()
    zip_path = Path(args.zip)
    dest = Path(args.dest)
    if not zip_path.exists():
        sys.exit(f"Source zip not found: {zip_path}")

    zf = zipfile.ZipFile(zip_path)
    xml_entries, images = index_zip(zf)

    roots, skipped_no_image, raw_classes = {}, [], set()
    for entry in xml_entries:
        stem = Path(entry).stem.lower()
        if stem not in images:
            skipped_no_image.append(Path(entry).name)
            continue
        try:
            root = ET.fromstring(zf.read(entry))
        except ET.ParseError as exc:
            print(f"WARNING: unparseable XML {entry}: {exc}")
            continue
        roots[stem] = root
        raw_classes.update(normalize_class(n) for n in object_names(root) if n.strip())

    existing_cfg = yaml.safe_load(Path(args.data).read_text())
    existing_names = existing_cfg.get("names") or {}
    if isinstance(existing_names, list):
        existing_names = {i: n for i, n in enumerate(existing_names)}
    existing_names = {int(k): v for k, v in existing_names.items()}

    new_ids = {}
    next_id = (max(existing_names) + 1) if existing_names else 0
    taken = set(existing_names.values())
    for cls in sorted(raw_classes):
        if cls in taken:
            continue
        new_ids[cls] = next_id
        next_id += 1
        taken.add(cls)
    lookup = {name: cid for cid, name in existing_names.items()}
    lookup.update(new_ids)

    img_dir = dest / "images" / "train"
    lbl_dir = dest / "labels" / "train"
    if not args.dry_run:
        img_dir.mkdir(parents=True, exist_ok=True)
        lbl_dir.mkdir(parents=True, exist_ok=True)

    written = 0
    empty_labels = []
    dropped_boxes = 0
    total_boxes = 0
    for stem, root in sorted(roots.items()):
        entry = images[stem]
        width = int(float(root.findtext("size/width") or 0))
        height = int(float(root.findtext("size/height") or 0))
        if width <= 0 or height <= 0:
            print(f"WARNING: no usable size for {Path(entry).name}, skipping")
            continue
        rows, dropped = convert_boxes(root, width, height, lookup)
        dropped_boxes += dropped
        total_boxes += len(rows)
        if not rows:
            empty_labels.append(Path(entry).name)
        ext = Path(entry).suffix.lower()
        out_img = img_dir / f"{PREFIX}{stem}{ext}"
        out_lbl = lbl_dir / f"{PREFIX}{stem}.txt"
        if not args.dry_run:
            out_img.write_bytes(zf.read(entry))
            out_lbl.write_text("\n".join(rows) + ("\n" if rows else ""))
        written += 1

    update_data_yaml(Path(args.data), {cid: name for name, cid in lookup.items()}, args.dry_run)
    added = sorted(((cid, name) for name, cid in new_ids.items()), key=lambda kv: kv[0])

    print("=== HoloSelecta ingest ===")
    print(f"  zip: {zip_path}")
    print(f"  xml annotations: {len(xml_entries)}")
    print(f"  converted images: {written}")
    print(f"  boxes written: {total_boxes} (dropped degenerate/unknown: {dropped_boxes})")
    print(f"  classes in dataset.yaml: {len(lookup)} (+{len(added)} new)")
    for cid, label in added:
        print(f"    {cid}: {label}")
    if skipped_no_image:
        print(f"  skipped {len(skipped_no_image)} XML(s) without an image: {', '.join(skipped_no_image[:5])}")
    if empty_labels:
        print(f"  WARNING: {len(empty_labels)} image(s) produced no labels: {', '.join(empty_labels[:5])}")
    print("Next: python prepare_dataset.py --val-ratio 0.2 --seed 42")


if __name__ == "__main__":
    main()
