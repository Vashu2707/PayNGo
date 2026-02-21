from ultralytics import YOLO
import cv2

model = YOLO("runs/detect/train2/weights/best.pt")

for result in model.predict(source=0, stream=True, device="mps"):
    frame = result.plot()
    cv2.imshow("YOLOv10 Live", frame)
    
    if cv2.waitKey(1) & 0xFF == ord("q"):
        break

cv2.destroyAllWindows()
