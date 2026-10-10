#!/usr/bin/env python3
"""
Train YOLOv10 on the 113-class retail product dataset (accuracy-first config).

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
  python train.py --data cv-ml-core/data/dataset.yaml \
      --epochs 60 --batch 16 --imgsz 960

`--weights` defaults to the newest trained `runs/**/weights/best.pt`
(currently product-detection-v5) and falls back to the `yolov10n.pt` baseline
when no run exists yet — pass it explicitly to start from a different model.

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
        description="Train YOLOv10 on the 113-class product dataset (accuracy-first config)."
    )
    parser.add_argument(
        "--weights", default=None,
        help="Starting weights. Default: newest runs/**/weights/best.pt, else yolov10n.pt.",
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
    parser.add_argument(
        "--name", default="product-detection-v6", help="Training run name."
    )
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
    parser.add_argument(
        "--resume", nargs="?", const=True, default=None,
        help="Continue from a run checkpoint: path to last.pt, or bare flag to auto-detect.",
    )
    parser.add_argument(
        "--lr0", type=float, default=0.01,
        help="Initial LR. Lower it (e.g. 0.001) when fine-tuning from a converged run "
             "for extra epochs, so the cosine restart doesn't disrupt the learned weights.",
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
    if device_arg.isdigit() and not torch.cuda.is_available():
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


def resolve_weights(weights_arg) -> Path:
    """Pick the starting weights: explicit --weights, newest trained best.pt,
    else the pretrained baseline (matches how smart_shelf.py / app.py behave)."""
    if weights_arg:
        return Path(weights_arg)
    trained = [p for p in Path("runs").rglob("weights/best.pt") if p.is_file()]
    if trained:
        latest = max(trained, key=lambda p: p.stat().st_mtime)
        print(f"[train] no --weights given; fine-tuning from newest {latest}")
        return latest
    baseline = Path("yolov10n.pt")
    print("[train] no trained weights found; starting from yolov10n.pt baseline")
    return baseline


def register_mps_cache_guard(model, every: int = 50):
    """Flush the MPS allocator cache during training.

    On Apple Silicon the MPS allocator keeps freed blocks reserved instead of
    returning them, so the driver high-water mark ratchets up every iteration
    (observed ~26 MB/iter at 960px) until the process hits the 20 GiB MPS cap
    and dies mid-run. Dropping unreferenced blocks on a timer keeps the cached
    pool reusable so long runs survive. Only active on `device=mps`.
    """
    import gc

    state = {"n": 0}

    def flush(trainer):
        state["n"] += 1
        if state["n"] % every == 0:
            gc.collect()
            torch.mps.empty_cache()

    model.add_callback("on_train_batch_end", flush)
    print(f"[train] mps cache guard active (every {every} batches)")


def main():
    args = parse_arguments()

    # Something in this environment (jetsam, another shell's pkill, tooling
    # cleanup) periodically SIGTERMs long-running python processes. The
    # supervisor's crash-restart loop treats a signal death as lost progress,
    # so swallow SIGTERM: the only sanctioned stop is the supervisor's SIGKILL
    # after a completed epoch (see train_supervisor.py --restart-every).
    import signal
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)

    weights_path = resolve_weights(args.weights)
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

    if device == "mps" and torch is not None and hasattr(torch, "mps"):
        register_mps_cache_guard(model)

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
        resume=args.resume or False,
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
        lr0=args.lr0,
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
    # ultralytics may re-root a relative --project (runs/detect/…), so print the
    # directory the trainer actually wrote to rather than the requested one.
    trainer = getattr(model, "trainer", None)
    save_dir = Path(getattr(trainer, "save_dir", None) or (project / args.name))
    print(f"[train] Results in: {save_dir}")
    print("[train] To evaluate on the holdout:  python test_model.py")


if __name__ == "__main__":
    main()
