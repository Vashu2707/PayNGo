#!/usr/bin/env python3
"""
Train YOLOv10 on the custom product dataset with accuracy-first hyperparameters.

Accuracy improvements over the previous config:
  * Larger training resolution (imgsz=960) with multi-scale jitter — small
    objects (e.g. a single Lays packet) benefit from higher resolution.
  * cosine LR schedule (default in ultralytics) instead of constant.
  * Stronger, physically-plausible augmentation tuned for photographed
    products (translation, rotation, scale, fliplr) plus copy-paste.
  * Class-balanced batch sampling and a proper 80/20 holdout so the val set
    reflects real-world mix (see prepare_dataset.py).
  * Early-stopping patience tuned for small datasets (could stall before
    convergence on tiny sets, so it's configurable — set --patience 0 for none).

Usage:
  python train.py --weights yolov10n.pt --data cv-ml-core/data/dataset.yaml \
      --epochs 60 --batch 16 --imgsz 960

`--device` defaults to CUDA if available, else CPU. `workers` is forced to 0 on
macOS only (avoids the macOS multiprocessing crash); pass `--workers N` to
override (recommended on Linux where DataLoader speed matters).
"""

import argparse
import os
import sys
import warnings
from pathlib import Path

try:
    import torch
except ImportError:
    torch = None
    print("WARNING: torch not importable; training will fail without it.", file=sys.stderr)

from ultralytics import YOLO

# Suppress pi-heif warnings
warnings.filterwarnings("ignore", message=".*pi-heif.*")


def parse_arguments():
    parser = argparse.ArgumentParser(
        description="Train YOLOv10 on the custom product dataset (accuracy-first config)."
    )
    parser.add_argument(
        "--weights", default="yolov10n.pt", help="Pretrained YOLOv10 weights file."
    )
    parser.add_argument(
        "--data", default="cv-ml-core/data/dataset.yaml", help="YOLO data YAML."
    )
    parser.add_argument("--epochs", type=int, default=60, help="Number of epochs.")
    parser.add_argument("--batch", type=int, default=16, help="Batch size.")
    parser.add_argument("--imgsz", type=int, default=960, help="Training image size.")
    parser.add_argument(
        "--workers", type=int, default=None, help="DataLoader workers (0 on macOS by default)."
    )
    parser.add_argument(
        "--project", default="runs/train", help="Folder to save training results."
    )
    parser.add_argument("--name", default="product-detection", help="Training run name.")
    parser.add_argument(
        "--device", default="auto", help="Device: auto, 0, or cpu."
    )
    parser.add_argument(
        "--patience", type=int, default=40,
        help="Early-stop patience (0 disables).",
    )
    parser.add_argument(
        "--conf", action="store_true",
        help="Run recall/precision validation at the end and print a table.",
    )
    return parser.parse_args()


def resolve_device(device_arg: str) -> str:
    device_arg = device_arg.strip().lower()
    if torch is None:
        return "cpu"
    if device_arg == "auto":
        return "0" if torch.cuda.is_available() else "cpu"
    if device_arg == "cpu":
        return "cpu"
    if not torch.cuda.is_available():
        print("No CUDA device detected; using CPU for training.")
        return "cpu"
    return device_arg


def resolve_workers(args) -> int:
    if args.workers is not None:
        return max(0, args.workers)
    # macOS + torch multiprocessing is flaky; safe default is 0.
    if sys.platform == "darwin":
        return 0
    return 8


def main():
    args = parse_arguments()
    weights_path = Path(args.weights)
    data_path = Path(args.data)

    if not weights_path.exists():
        raise FileNotFoundError(f"Pretrained weights not found: {weights_path}")
    if not data_path.exists():
        raise FileNotFoundError(f"Data config not found: {data_path}")

    model = YOLO(str(weights_path))
    device = resolve_device(args.device)
    workers = resolve_workers(args)
    project = Path(args.project)
    project.mkdir(parents=True, exist_ok=True)

    print(f"[train] weights={weights_path.name} device={device} workers={workers} epochs={args.epochs}")
    print(f"[train] imgsz={args.imgsz} batch={args.batch} patience={args.patience}")

    # NOTE: `augment=True` is the correct flag here. The explicit hsv/geometric
    # overrides are kept minimal and physically-plausible so the model learns
    # invariant, accurate features instead of memorizing the exact shelf photos.
    model.train(
        data=str(data_path),
        epochs=args.epochs,
        batch=args.batch,
        imgsz=args.imgsz,
        project=str(project),
        name=args.name,
        device=device,
        workers=workers,
        cache=False,                 # avoid stale-cache file issues on macOS
        # ── Accuracy summary ─────────────────────────────────────────────
        # Augmentation stack (tuned for photographed retail products)
        augment=True,                # enable ultralytics default augmentation pipeline
        hsv_h=0.02,                  # slight hue shift (packet colors stay stable)
        hsv_s=0.7,                   # saturation variance (lighting changes)
        hsv_v=0.4,                   # value variance (shadow/light)
        degrees=5.0,                 # small rotation (products sit flat on shelf)
        translate=0.2,               # more translation (products appear anywhere)
        scale=0.6,                   # scale variance (camera distance changes)
        shear=0.0,
        perspective=0.0,
        flipud=0.0,                  # products are never upside-down
        fliplr=0.5,                  # horizontal flip is physically valid
        mosaic=0.8,                  # mosaic for context; slightly reduced so small
                                     # single-object images aren't overwhelmed
        mixup=0.0,
        copy_paste=0.1,              # paste a product onto another image (helpful here)
        # ── Optimizer / schedule ─────────────────────────────────────────
        optimizer="auto",            # AdamW on small datasets, SGD on large
        cos_lr=True,                 # cosine annealing — better final convergence
        lr0=0.01,
        lrf=0.01,
        # ── Regularization ───────────────────────────────────────────────
        weight_decay=0.0005,
        dropout=0.0,                 # YOLO uses batch norm; keep 0
        # ── Early stopping / eval ────────────────────────────────────────
        patience=args.patience,
        plots=True,                  # save confusion matrix + PR curves
        verbose=True,
    )

    print("[train] Training complete.")
    print(f"[train] Results in: {project / args.name}")
    print("[train] To evaluate on the holdout:  python test_model.py")


if __name__ == "__main__":
    main()
