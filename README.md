# Shelf Product Detection

This project uses a YOLOv10 model to detect multiple products from a live camera feed.

## What it does
- Loads a custom trained YOLOv10 model
- Opens the default camera
- Detects products in real time
- Overlays bounding boxes and confidence scores
- Displays custom trained products in GREEN and other objects in RED
- Shows live statistics including detection counts and confidence

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
python app.py
```

## Train on custom product dataset
The dataset is stored in `cv-ml-core/data/yolo-dataset` with labels under `labels/train` and `labels/val`, and the config is in `cv-ml-core/data/dataset.yaml`.

```bash
python train.py --weights yolov10n.pt --data cv-ml-core/data/dataset.yaml --epochs 20 --batch 16
```

The training results will be saved under `runs/train/`.

## Test the model
Test the trained model on validation images:

```bash
python test_model.py
```

## Notes
- The app automatically loads custom product class names from `cv-ml-core/data/dataset.yaml`
- Custom trained products are displayed with GREEN bounding boxes
- Other objects detected by the pretrained model are shown with RED bounding boxes
- Training uses data augmentation and regularization to prevent overfitting
