"""Unit tests for the pure pick/place EventDetector logic.

Run from the project root (inside the venv):

    python -m unittest discover -s tests -v
"""

import unittest

from event_detector import EventDetector

NAMES = {0: "blue-lays", 1: "green-lays"}


def make_detector(warmup=2, stability=3, removal=4):
    return EventDetector(
        class_names=NAMES,
        stability_frames=stability,
        removal_frames=removal,
        warmup_frames=warmup,
    )


def feed(detector, active, frames):
    """Feed the same `active` map for `frames` iterations; return all events."""
    events = []
    for _ in range(frames):
        events.extend(detector.update(active))
    return events


class WarmupTests(unittest.TestCase):
    def test_no_events_during_or_right_after_warmup(self):
        det = make_detector(warmup=3)
        events = feed(det, {1: 0}, 10)
        self.assertEqual(events, [])
        self.assertEqual(det.cart_items(), [])

    def test_baseline_items_do_not_fire_pick_when_shelf_stays_loaded(self):
        det = make_detector(warmup=2)
        feed(det, {1: 0, 2: 1}, 20)
        self.assertEqual(det.cart_items(), [])


class PickTests(unittest.TestCase):
    def test_stable_item_disappearing_is_a_pick(self):
        det = make_detector(warmup=2, stability=3, removal=4)
        feed(det, {1: 0}, 5)          # baseline shelf
        events = feed(det, {}, 4)     # item gone long enough
        picks = [e for e in events if e["type"] == "pick"]
        self.assertEqual(len(picks), 1)
        self.assertEqual(picks[0]["product"], "blue-lays")
        self.assertEqual(picks[0]["quantity"], 1)

    def test_pick_added_to_cart_once(self):
        det = make_detector(warmup=2, stability=3, removal=4)
        feed(det, {1: 0}, 5)
        feed(det, {}, 10)             # well past removal
        self.assertEqual(det.cart_items(), [{"name": "blue-lays", "quantity": 1}])

    def test_briefly_seen_item_does_not_fire_pick(self):
        # Item visible for fewer than `stability` frames -> flicker, not a pick.
        det = make_detector(warmup=1, stability=5, removal=3)
        feed(det, {7: 1}, 2)          # appeared=2 < stability
        events = feed(det, {}, 10)
        self.assertEqual(events, [])
        self.assertEqual(det.cart_items(), [])


class PlaceTests(unittest.TestCase):
    def test_new_stable_item_is_a_place_and_clamps_at_zero(self):
        det = make_detector(warmup=2)
        feed(det, {}, 3)              # settle baseline
        events = feed(det, {9: 1}, 3)  # appears and stabilises
        places = [e for e in events if e["type"] == "place"]
        self.assertEqual(len(places), 1)
        self.assertEqual(places[0]["product"], "green-lays")
        self.assertEqual(det.cart_items(), [])  # clamped at 0

    def test_place_fires_exactly_once(self):
        det = make_detector(warmup=2)
        feed(det, {}, 3)
        events = feed(det, {9: 1}, 30)
        self.assertEqual(len([e for e in events if e["type"] == "place"]), 1)


class CartTests(unittest.TestCase):
    def test_cart_items_sorted_and_zero_quantity_hidden(self):
        det = make_detector(warmup=1, stability=2, removal=2)
        # pick blue then pick green
        feed(det, {1: 0}, 3)
        feed(det, {}, 2)
        feed(det, {2: 1}, 3)
        feed(det, {}, 2)
        self.assertEqual(
            det.cart_items(),
            [
                {"name": "blue-lays", "quantity": 1},
                {"name": "green-lays", "quantity": 1},
            ],
        )

    def test_reset_cart_clears_quantities_but_keeps_tracks(self):
        det = make_detector(warmup=2, stability=3, removal=4)
        feed(det, {1: 0}, 5)
        feed(det, {}, 4)
        self.assertNotEqual(det.cart_items(), [])
        det.reset_cart()
        self.assertEqual(det.cart_items(), [])
        # Shelf tracking still works afterwards.
        events = feed(det, {5: 0}, 3)
        self.assertEqual([e["type"] for e in events], ["place"])
        self.assertEqual(det.cart_items(), [])  # place clamped at 0


if __name__ == "__main__":
    unittest.main()
