#!/usr/bin/env python3
"""Keep a YOLO training run alive across Apple-Silicon MPS out-of-memory crashes.

On MPS the allocator never returns freed blocks to the driver, so a long run's
high-water mark ratchets up every batch (measured ~33 MB/batch at 960px) until
macOS refuses further allocations and the process dies. Ultralytics checkpoints
`last.pt` after every epoch, so the fix is simply to relaunch with
`--resume <last.pt>` after a crash: the new process starts with a clean
allocator and continues from the last completed epoch.

The supervisor only restarts on a non-zero exit (a crash). If train.py exits 0
the run is finished — either all epochs are done or early stopping fired.

Usage:
  python train_supervisor.py --weights runs/detect/runs/train/product-detection-v5/weights/best.pt \
      --name product-detection-v6 --epochs 60 --batch 12 --imgsz 540 --device mps
"""

import argparse
import csv
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional


def parse_args():
    p = argparse.ArgumentParser(description="Restart train.py after crashes until it finishes.")
    p.add_argument("--weights", required=True, help="Starting weights for a fresh run.")
    p.add_argument("--data", default="cv-ml-core/data/dataset.yaml")
    p.add_argument("--epochs", type=int, default=60)
    p.add_argument("--batch", type=int, default=4)
    p.add_argument("--imgsz", type=int, default=960)
    p.add_argument("--device", default="mps")
    p.add_argument("--name", default="product-detection-v6")
    p.add_argument("--patience", type=int, default=40)
    p.add_argument("--lr0", type=float, default=0.01, help="Initial LR for the run.")
    p.add_argument("--max-stalls", type=int, default=8)
    p.add_argument(
        "--restart-every", type=int, default=2,
        help="Recycle the trainer after N completed epochs so the MPS memory ratchet "
             "(~300 MB/epoch, never returned to the driver) never reaches the "
             "20 GiB cap that makes macOS SIGTERM the process.",
    )
    p.add_argument(
        "--daemon", action="store_true",
        help="Double-fork into a new session so tool-call aborts/pgroup kills can't take us down.",
    )
    return p.parse_args()


def detach():
    """Leave the caller's session/process group (survives tool-call aborts)."""
    if os.fork() > 0:
        os._exit(0)
    os.setsid()
    if os.fork() > 0:
        os._exit(0)


def find_checkpoint(name: str) -> Optional[Path]:
    """Newest last.pt belonging to a run called <name> or <name>-N."""
    hits = []
    for p in Path("runs").rglob("last.pt"):
        run = p.parent.parent.name
        if run == name or (run.startswith(name + "-") and run[len(name) + 1:].isdigit()):
            hits.append(p)
    return max(hits, key=lambda p: p.stat().st_ctime) if hits else None


def completed_epochs(run_dir: Path) -> int:
    """Highest epoch number logged in results.csv (dedup-safe: a crashed epoch
    can append its row before the checkpoint save lands, so row count overcounts)."""
    csv_path = run_dir / "results.csv"
    if not csv_path.exists():
        return 0
    best = 0
    with csv_path.open() as fh:
        for i, row in enumerate(csv.reader(fh)):
            if i == 0:
                continue
            try:
                best = max(best, int(float(row[0])))
            except (ValueError, IndexError):
                pass
    return best


def log(msg: str):
    print(f"[supervisor {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def main():
    args = parse_args()
    if args.daemon:
        detach()
    log(f"supervisor pid {os.getpid()} (ppid {os.getppid()})")
    ckpt = find_checkpoint(args.name)
    done = completed_epochs(ckpt.parent.parent) if ckpt else 0
    log(f"target={args.epochs} epochs, checkpoint={'none' if not ckpt else ckpt}, done={done}")

    stalls = 0
    attempt = 0
    while True:
        attempt += 1
        cmd = [
            sys.executable, "train.py",
            "--weights", args.weights,
            "--data", args.data,
            "--epochs", str(args.epochs),
            "--batch", str(args.batch),
            "--imgsz", str(args.imgsz),
            "--device", args.device,
            "--name", args.name,
            "--patience", str(args.patience),
            "--lr0", str(args.lr0),
        ]
        if ckpt:
            cmd += ["--resume", str(ckpt)]
        log(f"attempt {attempt}: {' '.join(cmd)}")

        proc = subprocess.Popen(cmd, start_new_session=True)
        start_done = done
        start_mtime = ckpt.stat().st_mtime if ckpt and ckpt.exists() else 0.0
        code = None
        planned = False
        while True:
            rc = proc.poll()
            if rc is not None:
                code = rc
                break
            time.sleep(20)
            new_ckpt = find_checkpoint(args.name)
            now = completed_epochs(new_ckpt.parent.parent) if new_ckpt else 0
            if now > done:
                done = now  # live progress for the restart budget
            if args.restart_every and now - start_done >= args.restart_every:
                # A results.csv row is written ~20s of poll-window before last.pt
                # is rewritten (save_model does a slow MPS deepcopy + isfinite sweep
                # first). Killing in that window leaves the checkpoint an epoch
                # behind, so the next resume re-runs the same epoch forever.
                # Wait until the checkpoint file actually advances, then recycle.
                deadline = time.time() + 120
                while time.time() < deadline:
                    if new_ckpt and new_ckpt.stat().st_mtime > start_mtime + 0.5:
                        break
                    if proc.poll() is not None:
                        break
                    time.sleep(5)
                log(f"planned restart: {now - start_done} epochs in this process (ratchet control)")
                planned = True
                # train.py ignores SIGTERM (external-kill noise), so go straight
                # to SIGKILL — the checkpoint was already written after the epoch.
                proc.kill()
                proc.wait()
                break
        if planned:
            log("process recycled cleanly")
        else:
            log(f"train.py exited with code {code}")

        new_ckpt = find_checkpoint(args.name)
        now = completed_epochs(new_ckpt.parent.parent) if new_ckpt else 0
        saved = bool(new_ckpt and new_ckpt.stat().st_mtime > start_mtime + 0.5)
        if now > start_done and saved:
            log(f"progress: {start_done} -> {now} epochs")
            stalls = 0
        elif now > start_done and not saved:
            stalls += 1
            log(f"epoch {now} logged but checkpoint never landed (stall {stalls}/{args.max_stalls})")
        elif not planned and code not in (-15, -9):
            stalls += 1
            log(f"no progress (stall {stalls}/{args.max_stalls})")
        ckpt = new_ckpt
        done = now if saved else start_done

        if code == 0:
            log(f"training finished cleanly at {done} epochs")
            return 0
        if done >= args.epochs:
            log(f"reached {done} epochs")
            return 0
        if stalls >= args.max_stalls:
            log("aborting: repeated crashes without progress")
            return 1
        time.sleep(5)


if __name__ == "__main__":
    sys.exit(main())
