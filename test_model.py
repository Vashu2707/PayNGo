#!/usr/bin/env python3
"""
Test script to validate the trained YOLO model on sample images
and check for false positives at different confidence thresholds.
"""
import argparse
from pathlib import Path
import cv2
from ultralytics import YOLO


def test_model_on_images(model_path, image_paths, confidence_thresholds=[0.3, 0.5, 0.7, 0.8]):
    """Test the model on images at different confidence thresholds."""
    model = YOLO(model_path)

    for img_path in image_paths:
        if not Path(img_path).exists():
            print(f"Image not found: {img_path}")
            continue

        print(f"\nTesting on: {img_path}")
        image = cv2.imread(img_path)

        for conf in confidence_thresholds:
            results = model(image, conf=conf, verbose=False)
            result = results[0]

            boxes = result.boxes
            if boxes is not None:
                detections = len(boxes)
                scores = boxes.conf.cpu().numpy()
                avg_conf = scores.mean() if len(scores) > 0 else 0.0
                print(".2f")
            else:
                print(f"  Conf {conf}: 0 detections")


def main():
    parser = argparse.ArgumentParser(description="Test YOLO model on sample images.")
    parser.add_argument("--model", default="runs/detect/runs/train/blue-lays2/weights/best.pt",
                       help="Path to the trained model weights.")
    parser.add_argument("--images", nargs="+",
                       default=["cv-ml-core/data/yolo-dataset/images/val/"],  # Default to val images
                       help="Paths to test images or directories containing images.")
    args = parser.parse_args()

    # Expand directories to image files
    image_paths = []
    for path in args.images:
        p = Path(path)
        if p.is_dir():
            # Find all image files in directory
            for ext in ['*.jpg', '*.jpeg', '*.png', '*.bmp']:
                image_paths.extend(p.glob(ext))
        elif p.exists():
            image_paths.append(p)

    if not image_paths:
        print("No images found to test on.")
        return

    print(f"Testing model: {args.model}")
    print(f"Found {len(image_paths)} images to test")

    test_model_on_images(args.model, [str(p) for p in image_paths])


if __name__ == "__main__":
    main()