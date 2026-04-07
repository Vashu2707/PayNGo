# Shelf Product Detection

This project uses a YOLOv10 model to detect products from a live camera feed.

## What it does
- Loads a pretrained `yolov10n.pt` model
- Opens the default camera
- Detects products in real time
- Overlays bounding boxes and confidence scores
- Displays a live "accuracy" estimate based on detection confidence

## Setup
1. Create and activate a Python virtual environment:
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   ```
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
3. Ensure the model file `yolov10n.pt` is present in the project root.

## Run
```bash
python app.py --weights yolov10n.pt --camera 0
```

## Train on blue-lays dataset
The dataset is stored in `cv-ml-core/data/yolo-dataset` with labels under `labels/train` and `labels/val`, and the config is in `cv-ml-core/data/dataset.yaml`.

```bash
python train.py --weights yolov10n.pt --data cv-ml-core/data/dataset.yaml --epochs 20 --batch 16
```

The training results will be saved under `runs/train/blue-lays`.

## Notes
- The app uses the preserved dataset config at `cv-ml-core/data/dataset.yaml` for custom label names when available.
- Training is now available through `train.py` and uses the existing `blue-lays` dataset.
