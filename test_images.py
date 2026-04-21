from ultralytics import YOLO
import cv2
import os

model = YOLO("runs/detect/runs/train/product-detection-v1-3/weights/best.pt")

folder = "test_images"

for file in os.listdir(folder):
    path = os.path.join(folder, file)

    img = cv2.imread(path)
    if img is None:
        print(f"Skipping {file}")
        continue

    results = model(img, conf=0.5)[0]
    annotated = results.plot()

    cv2.imshow("Result", annotated)
    cv2.waitKey(0)

cv2.destroyAllWindows()