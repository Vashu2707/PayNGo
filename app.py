#!/usr/bin/env python3
"""
YOLOv10 Product Detection
GREEN → Custom trained products
RED → Other objects (pretrained YOLO)
"""

import cv2
from pathlib import Path
from ultralytics import YOLO

# Colors
GREEN = (0, 255, 0)
RED = (0, 0, 255)
WHITE = (255, 255, 255)
GRAY = (200, 200, 200)

FONT = cv2.FONT_HERSHEY_SIMPLEX


# ---------- UTIL ----------
def find_latest_model():
    paths = list(Path("runs").rglob("best.pt"))
    if not paths:
        return None
    return str(sorted(paths)[-1])


def draw_label(frame, text, x, y, color):
    (w, h), _ = cv2.getTextSize(text, FONT, 0.5, 1)

    cv2.rectangle(frame, (x, y - h - 8), (x + w + 4, y + 2), color, -1)
    cv2.putText(frame, text, (x + 2, y - 2), FONT, 0.5, (0, 0, 0), 1)


# ---------- DRAW DETECTIONS ----------
def draw_detections(frame, custom_result, pretrained_result):
    custom_count = 0
    other_count = 0
    total_conf = 0
    total_det = 0

    # ---- Custom Model (GREEN) ----
    if custom_result.boxes is not None:
        for box in custom_result.boxes:
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            conf = float(box.conf[0])
            cls = int(box.cls[0])
            label = custom_result.names[cls]

            cv2.rectangle(frame, (x1, y1), (x2, y2), GREEN, 2)
            draw_label(frame, f"{label} {conf:.2f}", x1, y1, GREEN)

            custom_count += 1
            total_conf += conf
            total_det += 1

    # ---- Pretrained Model (RED) ----
    if pretrained_result.boxes is not None:
        for box in pretrained_result.boxes:
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            conf = float(box.conf[0])
            cls = int(box.cls[0])
            label = pretrained_result.names[cls]

            cv2.rectangle(frame, (x1, y1), (x2, y2), RED, 2)
            draw_label(frame, f"{label} {conf:.2f}", x1, y1, RED)

            other_count += 1
            total_conf += conf
            total_det += 1

    avg_conf = (total_conf / total_det) * 100 if total_det else 0

    return avg_conf, total_det, custom_count, other_count


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
def main():
    # Load custom model
    model_path = find_latest_model()

    if model_path:
        print(f"Using custom model: {model_path}")
        custom_model = YOLO(model_path)
    else:
        print("No custom model found. Using default.")
        custom_model = YOLO("yolov10n.pt")

    # Pretrained model
    pretrained_model = YOLO("yolov10n.pt")

    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("Camera error")
        return

    print("Press 'q' to exit")

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        # Run models
        custom_result = custom_model(frame, conf=0.5, verbose=False)[0]
        pretrained_result = pretrained_model(frame, conf=0.5, verbose=False)[0]

        # Draw everything
        acc, total, custom, other = draw_detections(
            frame, custom_result, pretrained_result
        )

        draw_stats(frame, total, custom, other, acc)

        cv2.imshow("YOLO Detection", frame)

        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()