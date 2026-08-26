"""Pure pick/place event logic for the PayNGo smart shelf.

Kept free of cv2 / ultralytics imports so it can be unit-tested cheaply
(see tests/test_event_detector.py).
"""

from collections import defaultdict


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

    def reset_cart(self):
        """Empty the cart (e.g. after a remote clear from the web UI).

        Tracked shelf state (`self.seen`) is kept — those are physical
        objects still sitting on the shelf.
        """
        self.cart = defaultdict(int)
