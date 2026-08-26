"""
Test script to validate the trained YOLO model on sample images
and check for false positives at different confidence thresholds.
"""
import argparse
from pathlib import Path

import cv2
from ultralytics import YOLO

IMAGE_GLOBS = ("*.jpg", "*.jpeg", "*.png", "*.bmp", "*.webp")


def find_latest_model():
    weights = [p for p in Path("runs").rglob("best.pt") if p.is_file()]
    if not weights:
        return None
    return str(max(weights, key=lambda p: p.stat().st_mtime))


def collect_images(paths):
    """Expand files/directories into a sorted list of image paths."""
    images = []
    for path in paths:
        p = Path(path)
        if p.is_dir():
            for pattern in IMAGE_GLOBS:
                images.extend(p.rglob(pattern))
        elif p.exists():
            images.append(p)
    return sorted({str(i) for i in images})


def test_model_on_images(model_path, image_paths, confidence_thresholds=(0.3, 0.5, 0.7, 0.8)):
    """Test the model on images at different confidence thresholds."""
    model = YOLO(model_path)

    for img_path in image_paths:
        print(f"\nTesting on: {img_path}")
        image = cv2.imread(img_path)
        if image is None:
            print("  Could not read image, skipping.")
            continue

        for conf in confidence_thresholds:
            result = model(image, conf=conf, verbose=False)[0]

            boxes = result.boxes
            if boxes is not None and len(boxes):
                detections = len(boxes)
                scores = boxes.conf.cpu().numpy()
                avg_conf = scores.mean() if len(scores) > 0 else 0.0
                print(f"  Conf {conf}: {detections} detections, avg conf {avg_conf:.2f}")
            else:
                print(f"  Conf {conf}: 0 detections")


def main():
    parser = argparse.ArgumentParser(description="Test YOLO model on sample images.")
    parser.add_argument("--model", default=None,
                        help="Path to trained weights. Defaults to the newest runs/**/best.pt.")
    parser.add_argument("--images", nargs="+",
                        default=["cv-ml-core/data/yolo-dataset/images/val"],
                        help="Image files or directories to test on.")
    parser.add_argument("--conf", type=float, nargs="+",
                        default=[0.3, 0.5, 0.7, 0.8],
                        help="Confidence thresholds to sweep.")
    args = parser.parse_args()

    model_path = args.model or find_latest_model()
    if not model_path:
        raise SystemExit("No trained model found. Train one or pass --model.")

    image_paths = collect_images(args.images)
    if not image_paths:
        raise SystemExit("No images found to test on.")

    print(f"Testing model: {model_path}")
    print(f"Found {len(image_paths)} image(s) to test")
    test_model_on_images(model_path, image_paths, tuple(args.conf))


if __name__ == "__main__":
    main()
