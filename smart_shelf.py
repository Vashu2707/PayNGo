#!/usr/bin/env python3
"""
PayNGo Smart Shelf - local computer vision app.

A webcam is mounted above a shelf. Products on the shelf are detected and
tracked with a trained YOLOv10 model. Two events are watched for:

  PICK  - a tracked product leaves the shelf   -> quantity added to the cart
  PLACE - a tracked product returns to the shelf -> quantity removed from cart

The cart state is synced to MongoDB so the Next.js UI (deployed on Vercel)
can display it. Run this script on the machine that has the camera.

Usage:
  python smart_shelf.py --display                 # show the live camera view
  python smart_shelf.py --camera 1 --conf 0.45    # tweak camera / confidence
  python smart_shelf.py --no-mongo                # run without syncing

Config (.env):
  MONGO_URI   mongodb+srv://user:pass@cluster.mongodb.net/payngo
  MONGO_DB    payngo
"""

import argparse
import os

# Prevent ultralytics from trying to auto-pip-install missing deps at runtime
# (it prints noisy retry warnings and calls `pip`, which may not be on PATH).
os.environ["YOLO_AUTOINSTALL"] = "false"

import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import cv2
import yaml
from ultralytics import YOLO

GREEN = (0, 255, 0)
RED = (0, 0, 255)
WHITE = (255, 255, 255)
GRAY = (160, 160, 160)

FONT = cv2.FONT_HERSHEY_SIMPLEX


# --------------------------------------------------------------------------
# Small .env loader (keeps dependencies minimal)
# --------------------------------------------------------------------------
def load_dotenv(path=".env"):
    if not Path(path).exists():
        return
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def parse_args():
    parser = argparse.ArgumentParser(description="PayNGo smart shelf app.")
    parser.add_argument(
        "--weights",
        default=None,
        help="Path to trained model. Defaults to the newest runs/**/weights/best.pt",
    )
    parser.add_argument(
        "--data", default="cv-ml-core/data/dataset.yaml", help="Dataset YAML for class names."
    )
    parser.add_argument("--camera", type=int, default=0, help="Camera device index.")
    parser.add_argument("--conf", type=float, default=0.5, help="Detection confidence threshold.")
    parser.add_argument(
        "--warmup",
        type=float,
        default=3.0,
        help="Seconds to observe the shelf before events are registered.",
    )
    parser.add_argument(
        "--stability",
        type=int,
        default=5,
        help="Frames a new object must persist before it counts as placed back.",
    )
    parser.add_argument(
        "--removal",
        type=int,
        default=8,
        help="Frames an object must be missing before it counts as picked.",
    )
    parser.add_argument(
        "--display", action="store_true", help="Show the annotated camera feed."
    )
    parser.add_argument(
        "--no-mongo", action="store_true", help="Disable MongoDB sync (local only)."
    )
    return parser.parse_args()


# --------------------------------------------------------------------------
# Model / config helpers
# --------------------------------------------------------------------------
def find_latest_model():
    weights = list(Path("runs").rglob("weights/best.pt"))
    if not weights:
        return None
    return str(max(weights, key=lambda p: p.stat().st_mtime))


def load_class_names(data_yaml):
    with open(data_yaml) as f:
        cfg = yaml.safe_load(f)
    names = cfg.get("names")
    if isinstance(names, dict):
        return {int(k): v for k, v in names.items()}
    return {i: n for i, n in enumerate(names)}


# --------------------------------------------------------------------------
# Event detection: turn raw tracks into PICK / PLACE events
# --------------------------------------------------------------------------
class EventDetector:
    """Compares tracked objects frame-to-frame and emits cart events.

    Every stable track id represents one physical item on the shelf.
      - An item that disappears -> PICK  (cart + 1)
      - A brand-new item that becomes stable -> PLACE (cart - 1)
    The first `warmup` frames build the baseline shelf; no events fire then.
    """

    def __init__(self, class_names, stability_frames, removal_frames, warmup_frames):
        self.class_names = class_names
        self.stability = stability_frames
        self.removal = removal_frames
        self.warmup = warmup_frames
        self.frame_count = 0
        self.seen = {}  # track_id -> state dict
        self.cart = defaultdict(int)  # class_name -> quantity

    def update(self, active):
        """active: {track_id: class_id}. Returns list of event dicts."""
        self.frame_count += 1
        current = set(active.keys())
        events = []
        in_warmup = self.frame_count <= self.warmup

        # New / still-present objects
        for tid, cls in active.items():
            if tid not in self.seen:
                self.seen[tid] = {
                    "cls": cls,
                    "first_seen": self.frame_count,
                    "appeared": 1,
                    "missing": 0,
                    "baseline": self.frame_count <= self.warmup,
                }
            else:
                self.seen[tid]["missing"] = 0
                self.seen[tid]["appeared"] += 1

        # Objects absent this frame
        for tid, st in self.seen.items():
            if tid not in current:
                st["missing"] += 1

        # New object became stable -> it was placed back on the shelf
        for tid, st in self.seen.items():
            if not st["baseline"] and st["appeared"] == self.stability:
                st["baseline"] = True
                if not in_warmup:
                    name = self.class_names.get(st["cls"], f"class-{st['cls']}")
                    self.cart[name] = max(0, self.cart[name] - 1)
                    events.append({"type": "place", "product": name, "quantity": 1})

        # Object gone long enough -> it was picked up
        for tid in list(self.seen.keys()):
            st = self.seen[tid]
            if st["missing"] >= self.removal and st["appeared"] >= self.stability:
                name = self.class_names.get(st["cls"], f"class-{st['cls']}")
                self.cart[name] += 1
                events.append({"type": "pick", "product": name, "quantity": 1})
                del self.seen[tid]

        return events

    def cart_items(self):
        return [
            {"name": name, "quantity": qty}
            for name, qty in sorted(self.cart.items())
            if qty > 0
        ]


# --------------------------------------------------------------------------
# MongoDB sync
# --------------------------------------------------------------------------
class CartStore:
    def __init__(self, uri, db_name):
        from pymongo import MongoClient

        self.client = MongoClient(uri, serverSelectionTimeoutMS=5000)
        self.db = self.client[db_name]
        self.cart_col = self.db["cart"]
        self.event_col = self.db["events"]
        self.event_col.create_index("ts")

    def save_cart(self, items):
        self.cart_col.replace_one(
            {"_id": "current"},
            {"items": items, "updatedAt": datetime.now(timezone.utc)},
            upsert=True,
        )

    def heartbeat(self):
        self.cart_col.update_one(
            {"_id": "current"},
            {"$set": {"updatedAt": datetime.now(timezone.utc)}},
            upsert=True,
        )

    def log_event(self, event):
        doc = dict(event)
        doc["ts"] = datetime.now(timezone.utc)
        self.event_col.insert_one(doc)

    def ping(self):
        self.client.admin.command("ping")
        return True


# --------------------------------------------------------------------------
# Drawing helpers (only used with --display)
# --------------------------------------------------------------------------
def draw_box(frame, x1, y1, x2, y2, cls_name, conf, tid):
    cv2.rectangle(frame, (x1, y1), (x2, y2), GREEN, 2)
    label = f"#{tid} {cls_name} {conf:.2f}"
    (w, h), _ = cv2.getTextSize(label, FONT, 0.5, 1)
    cv2.rectangle(frame, (x1, y1 - h - 8), (x1 + w + 4, y1 + 2), GREEN, -1)
    cv2.putText(frame, label, (x1 + 2, y1 - 2), FONT, 0.5, (0, 0, 0), 1)


def draw_cart(frame, items, last_events):
    x, y = 10, 30
    cv2.putText(frame, "CART", (x, y), FONT, 0.7, WHITE, 2)
    y += 22
    if not items:
        cv2.putText(frame, "(empty)", (x, y), FONT, 0.6, GRAY, 1)
    for it in items:
        cv2.putText(
            frame,
            f"{it['name']}  x{it['quantity']}",
            (x, y),
            FONT,
            0.6,
            GREEN,
            1,
        )
        y += 24
    y += 8
    for ev in last_events[-5:]:
        color = RED if ev["type"] == "pick" else GREEN
        txt = f"{ev['type'].upper()} {ev['product']}"
        cv2.putText(frame, txt, (x, y), FONT, 0.5, color, 1)
        y += 20


# --------------------------------------------------------------------------
# Main loop
# --------------------------------------------------------------------------
def main():
    args = parse_args()
    load_dotenv()

    # ByteTrack (object tracking) needs the 'lap' package. Fail fast with a
    # clear message instead of a mid-loop ImportError.
    try:
        import lap  # noqa: F401
    except ImportError:
        raise SystemExit(
            "Missing dependency 'lap' (required for object tracking).\n"
            "  Install it:        pip install \"lap>=0.5.12\"\n"
            "  Or use the venv:   source venv/bin/activate  (then run again)"
        )

    # Model + classes
    model_path = args.weights or find_latest_model()
    if not model_path:
        raise SystemExit("No trained model found. Train one or pass --weights.")
    print(f"[smart-shelf] model: {model_path}")

    if Path(args.data).exists():
        class_names = load_class_names(args.data)
    else:
        model = YOLO(model_path)
        class_names = model.names
    print(f"[smart-shelf] classes: {list(class_names.values())}")

    model = YOLO(model_path)

    # MongoDB
    store = None
    if not args.no_mongo:
        uri = os.getenv("MONGO_URI")
        db_name = os.getenv("MONGO_DB", "payngo")
        if uri:
            try:
                store = CartStore(uri, db_name)
                store.ping()
                print("[smart-shelf] MongoDB connected.")
            except Exception as exc:  # noqa: BLE001
                print(f"[smart-shelf] WARNING: MongoDB unavailable ({exc}); running local-only.")
                store = None
        else:
            print("[smart-shelf] WARNING: MONGO_URI not set; running local-only.")

    # Camera
    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        raise SystemExit(f"Could not open camera {args.camera}.")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    warmup_frames = max(1, int(args.warmup * fps))

    detector = EventDetector(
        class_names=class_names,
        stability_frames=args.stability,
        removal_frames=args.removal,
        warmup_frames=warmup_frames,
    )

    last_events = []
    last_sync = 0.0
    last_heartbeat = 0.0
    print("[smart-shelf] warming up... point the camera at the loaded shelf.")

    while True:
        ret, frame = cap.read()
        if not ret:
            print("[smart-shelf] Camera read failed.")
            break

        result = model.track(
            frame, persist=True, tracker="bytetrack.yaml", conf=args.conf, verbose=False
        )[0]

        active = {}
        if result.boxes is not None and result.boxes.id is not None:
            ids = result.boxes.id.cpu().tolist()
            clss = result.boxes.cls.cpu().tolist()
            active = {int(i): int(c) for i, c in zip(ids, clss)}

        events = detector.update(active)
        if events:
            last_events.extend(events)
            for ev in events:
                print(f"[smart-shelf] EVENT {ev['type'].upper()}: {ev['product']}")

        # Sync to MongoDB on change or every 2s (heartbeat keeps UI "live")
        now = time.time()
        items = detector.cart_items()
        if store is not None:
            if items != getattr(store, "_last_items", None):
                store.save_cart(items)
                store._last_items = items
                for ev in events:
                    store.log_event(ev)
                last_sync = now
            elif now - last_heartbeat > 2.0:
                store.heartbeat()
                last_heartbeat = now

        if args.display:
            for box in result.boxes or []:
                x1, y1, x2, y2 = map(int, box.xyxy[0])
                conf = float(box.conf[0])
                cls = int(box.cls[0])
                tid = int(box.id[0]) if box.id is not None else 0
                draw_box(frame, x1, y1, x2, y2, class_names.get(cls, "?"), conf, tid)
            draw_cart(frame, items, last_events)

            cv2.imshow("PayNGo Smart Shelf", frame)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break

    cap.release()
    if args.display:
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
