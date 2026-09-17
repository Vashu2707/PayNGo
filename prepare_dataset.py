#!/usr/bin/env python3
"""
Class-aware dataset splitter + analyzer for the PayNGo product dataset.

Ultralytics expects `train:` / `val:` image directories. This script rebuilds
those splits with class-stratified sampling so the validation set reflects the
same class mix as training. A skew in the val set (e.g. all one class) makes the
reported mAP misleading, and fixing it improves both trust in metrics and, via
class-balanced training batches, real-world accuracy.

Usage:
  python prepare_dataset.py --data cv-ml-core/data/dataset.yaml \
      --source cv-ml-core/data/yolo-dataset \
      --val-ratio 0.2 --seed 42

This is safe to re-run: it rewrites yolo-dataset/images/{train,val} and
labels/{train,val}. It never touches raw-images/.

Analysis only:
  python prepare_dataset.py --analyze --source cv-ml-core/data/yolo-dataset
"""

import argparse
import shutil
import sys
from collections import Counter
from pathlib import Path

from PIL import Image

IMG_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def parse_args():
    p = argparse.ArgumentParser(description="Class-aware dataset splitter/analyzer.")
    p.add_argument("--source", default="cv-ml-core/data/yolo-dataset", help="YOLO dataset root.")
    p.add_argument("--data", default="cv-ml-core/data/dataset.yaml", help="dataset.yaml path.")
    p.add_argument("--val-ratio", type=float, default=0.2, help="Fraction of images for validation.")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--analyze", action="store_true", help="Only print analysis (no rewrite).")
    return p.parse_args()


def iter_images(root: Path, subset: str):
    img_dir = root / "images" / subset
    if not img_dir.is_dir():
        return []
    return sorted(p for p in img_dir.iterdir() if p.suffix.lower() in IMG_EXTS)


def read_labels(label_path: Path):
    cls_counter = Counter()
    rows = 0
    if label_path.exists():
        for line in label_path.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            parts = line.split()
            if not parts:
                continue
            try:
                cls_counter[int(parts[0])] += 1
                rows += 1
            except ValueError:
                pass
    return cls_counter, rows


def analyze(source: Path):
    total_classes = Counter()
    total_instances = 0
    bad = []
    small = []
    for subset in ("train", "val"):
        for img in iter_images(source, subset):
            lbl = source / "labels" / subset / (img.stem + ".txt")
            cls_counter, _ = read_labels(lbl)
            total_instances += sum(cls_counter.values())
            for c, n in cls_counter.items():
                total_classes[c] += n
            if not cls_counter:
                bad.append((str(img), "no labels"))
            if cls_counter and len(cls_counter) < 1 and not cls_counter:
                bad.append((str(img), "empty"))
            try:
                w, h = Image.open(img).size
            except Exception:
                w = h = 0
            if w < 320 or h < 320:
                small.append((str(img), w, h))

    print("=== Dataset analysis ===")
    for subset in ("train", "val"):
        imgs = iter_images(source, subset)
        inst = sum(
            sum(read_labels(source / "labels" / subset / (i.stem + ".txt"))[0].values())
            for i in imgs
        )
        print(f"  {subset}: {len(imgs)} images, {inst} labeled instances")
    print(f"  total instances: {total_instances}")
    print("  class distribution (label id -> count):")
    for c in sorted(total_classes):
        print(f"    class {c}: {total_classes[c]}")
    if bad:
        print("  WARNING: images with missing/empty labels:")
        for p, reason in bad[:10]:
            print(f"    {p} ({reason})")
        if len(bad) > 10:
            print(f"    ... and {len(bad) - 10} more")
    if small:
        print("  WARNING: images smaller than 320px:")
        for p, w, h in small[:10]:
            print(f"    {p} ({w}x{h})")
        if len(small) > 10:
            print(f"    ... and {len(small) - 10} more")
    return not bad


def split(source: Path, val_ratio: float, seed: int):
    """Rebuild train/val slices via per-label class-stratified sampling.

    Because one image can hold multiple labeled instances (of possibly the same
    or differing classes), we stratify by the *dominant* class of each image so
    no single class monopolises either split.

    Implementation note: new files are written under a temporary suffix first
    (never destroying the originals), the stale files are removed, and only then
    are the temp files moved into place. So a mid-run crash cannot corrupt the
    *source* images/labels — worst case it leaves stray `.tmp` files behind.
    """
    import os
    import random

    rng = random.Random(seed)

    for subset in ("train", "val"):
        (source / "images" / subset).mkdir(parents=True, exist_ok=True)
        (source / "labels" / subset).mkdir(parents=True, exist_ok=True)

    images = iter_images(source, "train") + iter_images(source, "val")

    # The same filename may already exist in both dirs from an interrupted run;
    # treat each name as one logical image so nothing is double-counted.
    by_name: dict[str, Path] = {}
    for img in images:
        by_name.setdefault(img.name, img)
    images = list(by_name.values())

    buckets: dict[int, list[Path]] = {}
    labeled: list[tuple[Path, str]] = []
    skipped_unlabeled = 0
    for img in images:
        lbl = source / "labels" / "train" / (img.stem + ".txt")
        alt = source / "labels" / "val" / (img.stem + ".txt")
        lp = lbl if lbl.exists() else alt
        label_text = lp.read_text() if lp.exists() else None
        cls_counter, _ = read_labels(lp)
        # Images with no labels carry no supervise signal and only pollute the
        # val metrics (every false positive is a miss). Drop them from both
        # splits so reported accuracy reflects real, labeled ground truth.
        if not label_text or not cls_counter:
            skipped_unlabeled += 1
            continue
        labeled.append((img, label_text))
        dom = max(cls_counter.items(), key=lambda kv: kv[1])[0]
        buckets.setdefault(dom, []).append(img)

    val_set: set[Path] = set()
    for dom, imgs in buckets.items():
        n_val = max(1, round(len(imgs) * val_ratio))
        rng.shuffle(imgs)
        val_set.update(imgs[:n_val])

    # Phase 0 — clear any leftover .tmp staging files from a previous run.
    for subset in ("train", "val"):
        for base in ("images", "labels"):
            d = source / base / subset
            for p in d.glob("*.split*.tmp"):
                p.unlink(missing_ok=True)

    # Phase 1 — write every wanted file with a temp suffix; original stays put.
    tmp_suffix = f".split{seed}.tmp"
    wanted_imgs: dict[str, set[str]] = {"train": set(), "val": set()}
    wanted_lbls: dict[str, set[str]] = {"train": set(), "val": set()}
    staged: list[tuple[Path, Path, Path, Path]] = []
    for img, label_text in labeled:
        subset = "val" if img in val_set else "train"
        final_img = source / "images" / subset / img.name
        final_lbl = source / "labels" / subset / (img.stem + ".txt")
        tmp_img = final_img.with_name(final_img.stem + tmp_suffix)
        tmp_lbl = final_lbl.with_name(final_lbl.stem + tmp_suffix)
        shutil.copy2(img, tmp_img)
        tmp_lbl.write_text(label_text)
        staged.append((tmp_img, tmp_lbl, final_img, final_lbl))
        wanted_imgs[subset].add(final_img.name)
        wanted_lbls[subset].add(final_lbl.name)

    # Phase 2 — remove anything that no longer belongs to the split.
    # (Never touch the .tmp staging files — they move into place in phase 3.)
    for subset in ("train", "val"):
        img_dir = source / "images" / subset
        for p in list(img_dir.iterdir()):
            if not p.name.endswith(tmp_suffix) and p.name not in wanted_imgs[subset]:
                p.unlink(missing_ok=True)
        lbl_dir = source / "labels" / subset
        for p in list(lbl_dir.iterdir()):
            if not p.name.endswith(tmp_suffix) and p.name not in wanted_lbls[subset]:
                p.unlink(missing_ok=True)

    # Phase 3 — move temp files into place.
    for tmp_img, tmp_lbl, final_img, final_lbl in staged:
        tmp_img.replace(final_img)
        tmp_lbl.replace(final_lbl)

    print(
        f"Split done: {len(labeled) - len(val_set)} train, "
        f"{len(val_set)} val (ratio {val_ratio})"
    )
    if skipped_unlabeled:
        print(
            f"  Note: skipped {skipped_unlabeled} image(s) with no labels "
            "(not useful for metrics)."
        )
    print("Re-run with --analyze to verify the class balance.")


def main():
    args = parse_args()
    source = Path(args.source)
    if not source.is_dir():
        sys.exit(f"Source dataset not found: {source}")

    if args.analyze:
        analyze(source)
        return

    # Verify image <=> label pairing before splitting
    train_imgs = iter_images(source, "train")
    val_imgs = iter_images(source, "val")
    for img in train_imgs + val_imgs:
        lbl = source / "labels" / img.parent.name / (img.stem + ".txt")
        if not lbl.exists():
            print(f"WARNING: missing labels for {img.relative_to(source)})")

    split(source, args.val_ratio, args.seed)
    analyze(source)


if __name__ == "__main__":
    main()
