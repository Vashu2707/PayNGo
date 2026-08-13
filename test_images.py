"""Visualize the trained model on the images in test_images/."""
import argparse
import os
from pathlib import Path

import cv2
from ultralytics import YOLO


def find_latest_model():
    weights = list(Path("runs").rglob("weights/best.pt"))
    if not weights:
        return None
    return str(max(weights, key=lambda p: p.stat().st_mtime))


def main():
    parser = argparse.ArgumentParser(description="Run the model on test images.")
    parser.add_argument(
        "--weights",
        default=find_latest_model(),
        help="Path to trained model. Defaults to the newest best.pt.",
    )
    parser.add_argument("--folder", default="test_images")
    parser.add_argument("--conf", type=float, default=0.5)
    parser.add_argument("--save", action="store_true", help="Save annotated images instead of showing them.")
    args = parser.parse_args()

    if not args.weights:
        raise SystemExit("No trained model found. Train one or pass --weights.")

    print(f"Model: {args.weights}")
    model = YOLO(args.weights)
    folder = Path(args.folder)
    if args.save:
        out = Path("runs/predict") / folder.name
        out.mkdir(parents=True, exist_ok=True)

    for file in sorted(folder.iterdir()):
        img = cv2.imread(str(file))
        if img is None:
            print(f"Skipping {file.name}")
            continue

        result = model(img, conf=args.conf, verbose=False)[0]
        annotated = result.plot()

        if args.save:
            dest = out / file.name
            cv2.imwrite(str(dest), annotated)
            print(f"Saved {dest}")
            continue

        cv2.imshow("Result", annotated)
        key = cv2.waitKey(0) & 0xFF
        if key == ord("q"):
            break

    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
