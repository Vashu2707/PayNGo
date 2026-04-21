#!/usr/bin/env python3
"""
YOLOv10 Product Detection System
Detects custom trained products with GREEN boundaries and other objects with RED boundaries.
"""
import argparse
from pathlib import Path

import cv2
import numpy as np
import yaml
from ultralytics import YOLO


# Color constants (BGR format)
COLOR_CUSTOM_PRODUCT = (0, 255, 0)  # Green for custom trained products
COLOR_OTHER_OBJECT = (0, 0, 255)    # Red for other detections
COLOR_WHITE = (255, 255, 255)
COLOR_GRAY = (200, 200, 200)

# UI constants
FONT = cv2.FONT_HERSHEY_SIMPLEX
FONT_SCALE = 0.6
FONT_THICKNESS = 1
LABEL_FONT_SCALE = 0.8
LABEL_FONT_THICKNESS = 2
BBOX_THICKNESS = 2


def load_dataset_names(config_path: Path):
    """
    Load class names from YAML dataset configuration.
    
    Args:
        config_path: Path to the dataset.yaml file
        
    Returns:
        List of class names or None if file doesn't exist
    """
    if not config_path.exists():
        print(f"Warning: Dataset config not found at {config_path}")
        return None

    try:
        with open(config_path, "r", encoding="utf-8") as file:
            data = yaml.safe_load(file)

        names = data.get("names")
        if isinstance(names, dict):
            return [names[key] for key in sorted(names, key=lambda k: int(k))]
        if isinstance(names, list):
            return names
    except Exception as e:
        print(f"Error loading dataset names: {e}")
    
    return None


def draw_label(frame, text: str, x: int, y: int, color=(0, 128, 255)):
    """
    Draw a label with background on the frame.
    
    Args:
        frame: Input frame (numpy array)
        text: Label text
        x, y: Position coordinates
        color: BGR color tuple
    """
    (text_width, text_height), _ = cv2.getTextSize(text, FONT, FONT_SCALE, FONT_THICKNESS)
    
    # Ensure label stays within frame boundaries
    x = max(2, x)
    y = max(text_height + 10, y)
    
    # Draw background rectangle
    cv2.rectangle(
        frame,
        (x - 2, y - text_height - 10),
        (x + text_width + 4, y + 4),
        color,
        -1
    )
    
    # Draw text
    cv2.putText(
        frame,
        text,
        (x, y - 4),
        FONT,
        FONT_SCALE,
        COLOR_WHITE,
        FONT_THICKNESS,
        cv2.LINE_AA
    )


def iou(box1, box2):
    """
    Calculate Intersection over Union (IoU) between two boxes.
    Boxes are in format [x1, y1, x2, y2]
    """
    x1_min, y1_min, x1_max, y1_max = box1
    x2_min, y2_min, x2_max, y2_max = box2
    
    # Calculate intersection area
    inter_x_min = max(x1_min, x2_min)
    inter_y_min = max(y1_min, y2_min)
    inter_x_max = min(x1_max, x2_max)
    inter_y_max = min(y1_max, y2_max)
    
    inter_width = max(0, inter_x_max - inter_x_min)
    inter_height = max(0, inter_y_max - inter_y_min)
    inter_area = inter_width * inter_height
    
    # Calculate union area
    box1_area = (x1_max - x1_min) * (y1_max - y1_min)
    box2_area = (x2_max - x2_min) * (y2_max - y2_min)
    union_area = box1_area + box2_area - inter_area
    
    if union_area == 0:
        return 0
    return inter_area / union_area


def draw_detections(frame, custom_result, pretrained_result, product_labels=None, iou_threshold=0.5):
    """
    Draw bounding boxes from both custom and pretrained models.
    Custom trained products are drawn in GREEN, others in RED.
    Uses IoU to avoid duplicate detections.
    
    Args:
        frame: Input frame (numpy array)
        custom_result: YOLO detection results from custom trained model
        pretrained_result: YOLO detection results from pretrained model
        product_labels: Set of custom product class names (drawn in green)
        iou_threshold: IoU threshold for considering detections as duplicates
        
    Returns:
        Tuple of (average_confidence, detection_count, custom_product_count, other_object_count)
    """
    product_labels = set(product_labels or [])
    
    # Extract custom model detections
    custom_detections = []
    boxes = custom_result.boxes
    if boxes is not None:
        xyxy = boxes.xyxy.cpu().numpy()
        scores = boxes.conf.cpu().numpy()
        class_ids = boxes.cls.cpu().numpy().astype(int)
        
        for bbox, score, class_id in zip(xyxy, scores, class_ids):
            try:
                label = custom_result.names[class_id]
            except Exception:
                label = f"Class {class_id}"
            
            custom_detections.append({
                'bbox': bbox,
                'score': score,
                'label': label,
                'is_custom': True
            })
    
    # Extract pretrained model detections
    pretrained_detections = []
    boxes = pretrained_result.boxes
    if boxes is not None:
        xyxy = boxes.xyxy.cpu().numpy()
        scores = boxes.conf.cpu().numpy()
        class_ids = boxes.cls.cpu().numpy().astype(int)
        
        for bbox, score, class_id in zip(xyxy, scores, class_ids):
            try:
                label = pretrained_result.names[class_id]
            except Exception:
                label = f"Class {class_id}"
            
            pretrained_detections.append({
                'bbox': bbox,
                'score': score,
                'label': label,
                'is_custom': False
            })
    
    # Filter pretrained detections to avoid duplicates with custom detections
    filtered_pretrained = []
    for pretrained_det in pretrained_detections:
        is_duplicate = False
        for custom_det in custom_detections:
            overlap = iou(pretrained_det['bbox'], custom_det['bbox'])
            if overlap > iou_threshold:
                is_duplicate = True
                break
        if not is_duplicate:
            filtered_pretrained.append(pretrained_det)
    
    # Combine all detections
    all_detections = custom_detections + filtered_pretrained
    
    custom_product_count = 0
    other_object_count = 0
    total_confidence = 0.0
    
    # Draw all detections
    for detection in all_detections:
        x1, y1, x2, y2 = detection['bbox'].astype(int)
        score = detection['score']
        label = detection['label']
        is_custom = detection['is_custom']
        
        # Determine color based on source
        if is_custom:
            color = COLOR_CUSTOM_PRODUCT  # Green
            custom_product_count += 1
        else:
            color = COLOR_OTHER_OBJECT    # Red
            other_object_count += 1
        
        # Draw bounding box
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, BBOX_THICKNESS)
        
        # Draw label with confidence
        label_text = f"{label}: {score:.2f}"
        draw_label(frame, label_text, x1 + 2, y1 + 24, color)
        
        total_confidence += float(score)
    
    total_count = len(all_detections)
    avg_confidence = float(total_confidence / total_count) if total_count else 0.0
    
    return avg_confidence, total_count, custom_product_count, other_object_count


def draw_stats_panel(frame, detection_count, custom_count, other_count, accuracy):
    """
    Draw statistics panel on the frame.
    
    Args:
        frame: Input frame (numpy array)
        detection_count: Total number of detections
        custom_count: Number of custom trained products detected
        other_count: Number of other objects detected
        accuracy: Average detection accuracy/confidence
    """
    # Top-left panel with detection stats
    cv2.putText(
        frame,
        f"Total Detections: {detection_count}",
        (10, 30),
        FONT,
        LABEL_FONT_SCALE,
        COLOR_WHITE,
        LABEL_FONT_THICKNESS
    )
    
    # Custom products in green
    cv2.putText(
        frame,
        f"Custom Products: {custom_count}",
        (10, 65),
        FONT,
        LABEL_FONT_SCALE,
        COLOR_CUSTOM_PRODUCT,
        LABEL_FONT_THICKNESS
    )
    
    # Other objects in red
    cv2.putText(
        frame,
        f"Other Objects: {other_count}",
        (10, 100),
        FONT,
        LABEL_FONT_SCALE,
        COLOR_OTHER_OBJECT,
        LABEL_FONT_THICKNESS
    )
    
    # Accuracy
    cv2.putText(
        frame,
        f"Avg Confidence: {accuracy:.1f}%",
        (10, 135),
        FONT,
        LABEL_FONT_SCALE,
        COLOR_WHITE,
        LABEL_FONT_THICKNESS
    )
    
    # Help text at bottom
    cv2.putText(
        frame,
        "Press 'q' to quit",
        (10, frame.shape[0] - 16),
        FONT,
        0.6,
        COLOR_GRAY,
        1
    )
    
    # Legend at bottom-right
    # Green box for custom products
    cv2.rectangle(frame, (frame.shape[1] - 220, frame.shape[0] - 55), 
                 (frame.shape[1] - 200, frame.shape[0] - 35), COLOR_CUSTOM_PRODUCT, -1)
    cv2.putText(
        frame,
        "= Custom Products",
        (frame.shape[1] - 190, frame.shape[0] - 40),
        FONT,
        0.5,
        COLOR_WHITE,
        1
    )
    
    # Red box for other objects
    cv2.rectangle(frame, (frame.shape[1] - 220, frame.shape[0] - 25), 
                 (frame.shape[1] - 200, frame.shape[0] - 5), COLOR_OTHER_OBJECT, -1)
    cv2.putText(
        frame,
        "= Other Objects",
        (frame.shape[1] - 190, frame.shape[0] - 10),
        FONT,
        0.5,
        COLOR_WHITE,
        1
    )


def parse_arguments():
    """Parse and return command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Live YOLOv10 Product Detection from Camera",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Default detection with blue-lays product
  python app.py
  
  # Custom product class
  python app.py --product-classes "blue-lays,pepsi"
  
  # Different model weights
  python app.py --weights runs/detect/runs/train/custom/weights/best.pt
        """
    )
    
    parser.add_argument(
        "--weights",
        default="runs/detect/runs/train/blue-lays2/weights/best.pt",
        help="Path to the YOLOv10 model weights file (default: %(default)s)"
    )
    
    parser.add_argument(
        "--camera",
        type=int,
        default=0,
        help="Camera device index (default: %(default)s)"
    )
    
    parser.add_argument(
        "--confidence",
        type=float,
        default=0.7,
        help="Minimum detection confidence threshold (default: %(default)s)"
    )
    
    parser.add_argument(
        "--data-config",
        default="cv-ml-core/data/dataset.yaml",
        help="Path to dataset YAML with class names (default: %(default)s)"
    )
    
    parser.add_argument(
        "--product-classes",
        default="",
        help="""Comma-separated custom product class names (drawn in GREEN).
If not provided, loads from --data-config. Other detections are shown in RED."""
    )
    
    return parser.parse_args()


def main():
    """Main detection loop."""
    args = parse_arguments()
    
    # Validate model weights path
    weights_path = Path(args.weights)
    if not weights_path.exists():
        raise FileNotFoundError(f"Model weights not found: {weights_path}")
    
    print(f"Loading custom model from: {weights_path}")
    print(f"Loading pretrained YOLOv10 model for general object detection...")
    print(f"Confidence threshold: {args.confidence}")
    print(f"Camera index: {args.camera}")

    # Load custom-trained model
    custom_model = YOLO(str(weights_path))
    
    # Load pretrained model for general object detection
    pretrained_model = YOLO("yolov10n.pt")

    # Open camera
    capture = cv2.VideoCapture(args.camera)
    if not capture.isOpened():
        raise RuntimeError(f"Cannot open camera index {args.camera}")

    # Load custom product labels from dataset config
    data_config_path = Path(args.data_config)
    dataset_names = load_dataset_names(data_config_path)
    if dataset_names:
        product_labels = set(dataset_names)
        print(f"Loaded custom product classes from {data_config_path}: {', '.join(product_labels)}")
    else:
        # Fallback to command line argument
        product_labels = {name.strip() for name in args.product_classes.split(",") if name.strip()}
        if not product_labels:
            print("Warning: No custom product classes specified and could not load from dataset config")
            product_labels = set()
        print(f"Using custom product classes from command line: {', '.join(product_labels)}")

    print(f"Custom product classes (GREEN): {', '.join(product_labels)}")
    print(f"Other detections (RED): All objects from pretrained model")
    print("Starting live detection. Press 'q' to exit.")
    print("-" * 60)

    try:
        while True:
            success, frame = capture.read()
            if not success:
                print("Error: Failed to read frame from camera")
                break

            # Run detection on both models
            custom_results = custom_model(frame, conf=args.confidence, verbose=False)
            custom_result = custom_results[0]
            
            pretrained_results = pretrained_model(frame, conf=args.confidence, verbose=False)
            pretrained_result = pretrained_results[0]

            # Draw detections from both models
            avg_confidence, detection_count, custom_count, other_count = draw_detections(
                frame,
                custom_result,
                pretrained_result,
                product_labels=product_labels
            )
            
            accuracy = avg_confidence * 100.0

            # Draw statistics panel
            draw_stats_panel(frame, detection_count, custom_count, other_count, accuracy)

            # Display frame
            cv2.imshow("YOLOv10 Product Detection - GREEN: Custom, RED: Other", frame)
            
            # Exit on 'q' key
            if cv2.waitKey(1) & 0xFF == ord("q"):
                print("\nExiting...")
                break

    except KeyboardInterrupt:
        print("\nInterrupted by user")
    finally:
        capture.release()
        cv2.destroyAllWindows()
        print("Detection stopped and resources released.")


if __name__ == "__main__":
    main()
