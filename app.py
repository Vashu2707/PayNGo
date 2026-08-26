#!/usr/bin/env python3
"""
YOLOv10 Product Detection demo
GREEN -> Custom trained products
RED   -> Other objects (pretrained YOLO)

Usage:
  python app.py                       # default camera, conf 0.5
  python app.py --camera 1 --conf 0.45
"""

import argparse
from pathlib import Path

import cv2
from ultralytics import YOLO

# Colors
GREEN = (0, 255, 0)
RED = (0, 0, 255)
WHITE = (255, 255, 255)
GRAY = (200, 200, 200)

FONT = cv2.FONT_HERSHEY_SIMPLEX

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


# ---------- UTIL ----------
def find_latest_model():
    paths = [p for p in Path("runs").rglob("best.pt") if p.is_file()]
    if not paths:
        return None
    return str(max(paths, key=lambda p: p.stat().st_mtime))


def draw_label(frame, text, x, y, color):
    (w, h), _ = cv2.getTextSize(text, FONT, 0.5, 1)

    cv2.rectangle(frame, (x, y - h - 8), (x + w + 4, y + 2), color, -1)
    cv2.putText(frame, text, (x + 2, y - 2), FONT, 0.5, (0, 0, 0), 1)


def draw_boxes(frame, result, color):
    """Draw every detection in `result` with `color`. Returns count."""
    count = 0
    if result.boxes is not None:
        for box in result.boxes:
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            conf = float(box.conf[0])
            cls = int(box.cls[0])
            label = result.names.get(cls, f"class-{cls}")

            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
            draw_label(frame, f"{label} {conf:.2f}", x1, y1, color)
            count += 1
    return count


# ---------- UI PANEL ----------
def draw_stats(frame, total, custom, other, acc):
    cv2.putText(frame, f"Total: {total}", (10, 30), FONT, 0.7, WHITE, 2)
    cv2.putText(frame, f"Custom: {custom}", (10, 60), FONT, 0.7, GREEN, 2)
    cv2.putText(frame, f"Other: {other}", (10, 90), FONT, 0.7, RED, 2)
    cv2.putText(frame, f"Confidence: {acc:.1f}%", (10, 120), FONT, 0.7, WHITE, 2)

    # Legend
    h, w, _ = frame.shape

    cv2.rectangle(frame, (w - 220, h - 60), (w - 200, h - 40), GREEN, -1)
    cv2.putText(frame, "Custom", (w - 190, h - 45), FONT, 0.5, WHITE, 1)

    cv2.rectangle(frame, (w - 220, h - 30), (w - 200, h - 10), RED, -1)
    cv2.putText(frame, "Other", (w - 190, h - 15), FONT, 0.5, WHITE, 1)

    cv2.putText(frame, "Press q to quit", (10, h - 10), FONT, 0.5, GRAY, 1)


# ---------- MAIN ----------
def parse_args():
    parser = argparse.ArgumentParser(description="Dual-model YOLOv10 demo.")
    parser.add_argument("--weights", default=None,
                        help="Custom model path. Defaults to newest runs/**/best.pt.")
    parser.add_argument("--camera", type=int, default=0, help="Camera device index.")
    parser.add_argument("--conf", type=float, default=0.5, help="Detection confidence threshold.")
    return parser.parse_args()


def main():
    args = parse_args()

    # Load custom model
    model_path = args.weights or find_latest_model()

    if model_path:
        print(f"Using custom model: {model_path}")
        custom_model = YOLO(model_path)
    else:
        print("No custom model found under runs/. Using pretrained for both.")
        custom_model = YOLO("yolov10n.pt")

    # Pretrained model
    pretrained_model = YOLO("yolov10n.pt")

    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        raise SystemExit(f"Could not open camera {args.camera}.")

    print("Press 'q' to exit")

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                print("Camera read failed.")
                break

            # Run models
            custom_result = custom_model(frame, conf=args.conf, verbose=False)[0]
            pretrained_result = pretrained_model(frame, conf=args.conf, verbose=False)[0]

            custom_count = draw_boxes(frame, custom_result, GREEN)
            other_count = draw_boxes(frame, pretrained_result, RED)

            total = custom_count + other_count
            all_confs = []
            for res in (custom_result, pretrained_result):
                if res.boxes is not None:
                    all_confs.extend(float(c) for c in res.boxes.conf)
            avg_conf = (sum(all_confs) / len(all_confs)) * 100 if all_confs else 0

            draw_stats(frame, total, custom_count, other_count, avg_conf)

            cv2.imshow("YOLO Detection", frame)

            if cv2.waitKey(1) & 0xFF == ord('q'):
                break
    except KeyboardInterrupt:
        pass
    finally:
        cap.release()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
