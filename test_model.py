"""
Evaluate a trained YOLO model on the labeled validation split and report real
accuracy metrics (not just detection counts).

This computes, at a chosen IoU threshold:
  * mAP (mean Average Precision) — the headline accuracy number
  * Per-class AP / precision / recall
  * Precision @ 0.5, Recall @ 0.5
  * False positive / false negative breakdown

Usage:
  python test_model.py --model runs/train/product-detection/weights/best.pt \
      --data cv-ml-core/data/dataset.yaml --iou 0.5 --conf 0.5
"""

import argparse
import sys
from pathlib import Path

import numpy as np
from ultralytics import YOLO

from prepare_dataset import iter_images, read_labels

IMG_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def parse_args():
    def latest_model():
        ws = [p for p in Path("runs").rglob("weights/best.pt") if p.is_file()]
        return str(max(ws, key=lambda p: p.stat().st_mtime)) if ws else None

    p = argparse.ArgumentParser(description="Evaluate model accuracy on the val split.")
    p.add_argument("--model", default=latest_model(), help="Path to best.pt.")
    p.add_argument("--data", default="cv-ml-core/data/dataset.yaml", help="YOLO dataset root dir.")
    p.add_argument("--root", default="cv-ml-core/data/yolo-dataset", help="YOLO dataset root.")
    p.add_argument("--conf", type=float, default=0.5)
    p.add_argument("--iou", type=float, default=0.5)
    p.add_argument("--subset", default="val", choices=["val", "train"])
    p.add_argument("--imgsz", type=int, default=960, help="Inference resolution.")
    return p.parse_args()


def iou(box_a, box_b):
    """box: (x1,y1,x2,y2) normalized [0,1]."""
    ax1, ay1, ax2, ay2 = box_a
    bx1, by1, bx2, by2 = box_b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    area_a = (ax2 - ax1) * (ay2 - ay1)
    area_b = (bx2 - bx1) * (by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def main():
    args = parse_args()
    if not args.model:
        sys.exit("No trained model found. Train one or pass --model.")

    # Load class names from ultralytics data yaml if present (dataset.yaml)
    class_names = {}
    data_yaml = Path(args.data)
    if data_yaml.exists():
        import yaml
        cfg = yaml.safe_load(data_yaml.read_text())
        names = cfg.get("names", {})
        class_names = {int(k): v for k, v in names.items()} if isinstance(names, dict) else {
            i: n for i, n in enumerate(names)
        }

    model = YOLO(args.model)
    print(f"Model: {args.model}")
    print(f"Evaluating on {args.subset} (conf={args.conf}, IoU={args.iou}, imgsz={args.imgsz})")

    root = Path(args.root)
    img_dir = root / "images" / args.subset

    images = iter_images(root, args.subset)
    if not images:
        sys.exit(f"No images found in {img_dir}")

    # For AP computation we need class -> (conf, correct_bool) per detection, per class.
    # We'll do a per-class precision-recall curve via the standard AP (interpolated).
    from collections import defaultdict
    class_detections = defaultdict(list)   # cls -> [(conf, is_correct)]
    stats = defaultdict(lambda: {"tp": 0, "fp": 0, "fn": 0, "gts": 0, "dets": 0})

    for img_path in images:
        lbl = root / "labels" / args.subset / (img_path.stem + ".txt")
        gts, _ = read_labels(lbl)
        # ground-truth boxes per class
        gt_boxes = defaultdict(list)
        if lbl.exists():
            for line in lbl.read_text().splitlines():
                parts = line.split()
                if len(parts) < 5:
                    continue
                c = int(parts[0])
                xc, yc, w, h = map(float, parts[1:5])
                x1, y1, x2, y2 = xc - w / 2, yc - h / 2, xc + w / 2, yc + h / 2
                gt_boxes[c].append((x1, y1, x2, y2))

        result = model(str(img_path), conf=args.conf, imgsz=args.imgsz, verbose=False)[0]
        preds = []  # (cls, conf, box)
        if result.boxes is not None:
            for box in result.boxes:
                x1, y1, x2, y2 = map(float, box.xyxy[0].tolist())
                conf = float(box.conf[0])
                cls = int(box.cls[0])
                H, W = result.orig_shape
                preds.append((cls, conf, (x1 / W, y1 / H, x2 / W, y2 / H)))

        # Match predictions to GT boxes (greedy by class + IoU)
        used = {c: set() for c in gt_boxes}  # per-class matched GT indices
        for cls, conf, pbox in sorted(preds, key=lambda x: -x[1]):
            best_iou, best_idx = 0.0, -1
            for idx, gbox in enumerate(gt_boxes.get(cls, [])):
                if idx in used[cls]:
                    continue
                v = iou(pbox, gbox)
                if v > best_iou:
                    best_iou, best_idx = v, idx
            if best_iou >= args.iou and best_idx != -1:
                is_correct = True
                used[cls].add(best_idx)
            else:
                is_correct = False
            class_detections[cls].append((conf, is_correct))
            stats[cls]["dets"] += 1
            stats[cls]["tp" if is_correct else "fp"] += 1

        # Unmatched GT = false negatives
        for cls in gt_boxes:
            stats[cls]["gts"] += len(gt_boxes[cls])
            stats[cls]["fn"] += len(gt_boxes[cls]) - len(used[cls])

    # ----- Per-class metrics -----
    print("\n=== Accuracy report ===")
    all_classes = sorted(class_names.keys()) if class_names else sorted(stats.keys())
    rows = []
    for cls in all_classes:
        s = stats[cls]
        p = s["tp"] / s["dets"] if s["dets"] else 0.0
        r = s["tp"] / s["gts"] if s["gts"] else 0.0
        rows.append((cls, s["gts"], s["tp"], s["fp"], s["fn"], p, r))

    header = f"{'class':<16} {'GT':>4} {'TP':>4} {'FP':>4} {'FN':>4} {'Prec':>6} {'Rec':>6}"
    print(header)
    print("-" * len(header))
    tot_gt = tot_tp = tot_fp = tot_fn = 0
    for cls, gt, tp, fp, fn, p, r in rows:
        name = class_names.get(cls, str(cls))
        print(f"{name:<16} {gt:>4} {tp:>4} {fp:>4} {fn:>4} {p:>6.3f} {r:>6.3f}")
        tot_gt += gt; tot_tp += tp; tot_fp += fp; tot_fn += fn
    if tot_gt:
        print("-" * len(header))
        print(f"{'ALL':<16} {tot_gt:>4} {tot_tp:>4} {tot_fp:>4} {tot_fn:>4} "
              f"{tot_tp / (tot_tp + tot_fp) if tot_tp + tot_fp else 0:>6.3f} "
              f"{tot_tp / tot_gt:>6.3f}")

    # ----- mAP (mean of per-class AP via 11-point interpolation) -----
    print("\n=== Mean Average Precision (11-point interpolated AP) ===")
    aps = []
    for cls in all_classes:
        dets = sorted(class_detections[cls], key=lambda d: -d[0])
        gt_total = stats[cls]["gts"]
        if gt_total == 0 or not dets:
            aps.append(0.0)
            continue
        tp_cum = fp_cum = 0
        recs, precs = [], []
        for conf, correct in dets:
            if correct:
                tp_cum += 1
            else:
                fp_cum += 1
            if tp_cum + fp_cum:
                precs.append(tp_cum / (tp_cum + fp_cum))
                recs.append(tp_cum / gt_total)
        # interpolate precision at 11 recall points
        interp = 0.0
        for r_point in np.linspace(0, 1, 11):
            idx = [i for i, r in enumerate(recs) if r >= r_point]
            interp += (max(precs[i] for i in idx) if idx else 0.0) / 11
        aps.append(interp)
        name = class_names.get(cls, str(cls))
        print(f"  AP@{args.iou} {name:<16} {interp:.3f}")
    mAP = float(np.mean(aps)) if aps else 0.0
    print(f"\n  mAP@{args.iou}: {mAP:.3f}")
    return mAP


if __name__ == "__main__":
    main()
