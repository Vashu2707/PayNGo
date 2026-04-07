#!/usr/bin/env python3
import argparse
from pathlib import Path

import torch
from ultralytics import YOLO


def parse_arguments():
    parser = argparse.ArgumentParser(description="Train YOLOv10 on the blue-lays shelf dataset.")
    parser.add_argument("--weights", default="yolov10n.pt", help="Path to the pretrained YOLOv10 weights file.")
    parser.add_argument("--data", default="cv-ml-core/data/dataset.yaml", help="Path to the YOLO data YAML file.")
    parser.add_argument("--epochs", type=int, default=20, help="Number of training epochs.")
    parser.add_argument("--batch", type=int, default=16, help="Training batch size.")
    parser.add_argument("--imgsz", type=int, default=640, help="Training image size.")
    parser.add_argument("--project", default="runs/train", help="Project folder to save training results.")
    parser.add_argument("--name", default="blue-lays", help="Name of the training run.")
    parser.add_argument("--device", default="auto", help="Device to use for training, e.g. auto, 0 or cpu.")
    return parser.parse_args()


def resolve_device(device_arg: str) -> str:
    device_arg = device_arg.strip().lower()
    if device_arg == "auto":
        return "0" if torch.cuda.is_available() else "cpu"
    if device_arg == "cpu":
        return "cpu"
    if not torch.cuda.is_available():
        print("No CUDA device detected; using CPU for training.")
        return "cpu"
    return device_arg


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

    print("Starting training on blue-lays dataset...")
    model.train(
        data=str(data_path),
        epochs=args.epochs,
        batch=args.batch,
        imgsz=args.imgsz,
        project=args.project,
        name=args.name,
        device=device,
        # Add data augmentation to prevent overfitting
        augment=True,
        hsv_h=0.015,  # Hue augmentation
        hsv_s=0.7,    # Saturation augmentation
        hsv_v=0.4,    # Value augmentation
        degrees=10.0, # Rotation augmentation
        translate=0.1, # Translation augmentation
        scale=0.5,    # Scale augmentation
        shear=0.0,    # Shear augmentation
        perspective=0.0, # Perspective augmentation
        flipud=0.0,   # Vertical flip
        fliplr=0.5,   # Horizontal flip
        mosaic=1.0,   # Mosaic augmentation
        mixup=0.0,    # Mixup augmentation
        # Add regularization to prevent overfitting
        dropout=0.1,  # Dropout rate
        weight_decay=0.0005,  # L2 regularization
    )

    print("Training complete. Check the results in the project directory.")


if __name__ == "__main__":
    main()
