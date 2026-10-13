"""Unit tests for the packshot -> shelf composite pipeline.

Run from the project root:

    python -m unittest discover -s tests -v
"""

import random
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

import synthesize_products as sp


def packshot(w=300, h=400, bg=255, product=(220, 40, 40), margin=60):
    """A white-background packshot with a coloured product in the middle."""
    img = np.full((h, w, 3), bg, dtype=np.uint8)
    img[margin : h - margin, margin : w - margin] = product
    return img


class CatalogTests(unittest.TestCase):
    def test_rejects_reordered_existing_products(self):
        rows = "\n".join(
            f"  - slug: {s}\n    source: existing\n"
            for s in ("green-lays", "blue-lays", "orange-lays", "dark-green-lays")
        )
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "c.yaml"
            p.write_text("products:\n" + rows)
            with self.assertRaises(SystemExit):
                sp.load_catalog(p)

    def test_loads_starter_catalog(self):
        products = sp.load_catalog(sp.DEFAULT_CATALOG)
        self.assertEqual([p.slug for p in products[:4]], list(sp.EXISTING_SLUGS))
        self.assertEqual(len({p.slug for p in products}), len(products))
        self.assertTrue(all(p.price > 0 for p in products))
        self.assertTrue(all(p.label for p in products))
        web = [p for p in products if p.source == "web"]
        self.assertTrue(web, "starter catalog should contain fetchable products")
        self.assertTrue(all(p.queries or p.urls for p in web), "web products need a query")

    def test_dataset_yaml_follows_catalog_order(self):
        products = sp.load_catalog(sp.DEFAULT_CATALOG)
        lines = sp.dataset_yaml_text(products).splitlines()
        names = [ln.split(": ", 1)[1] for ln in lines if ln.startswith("  ")]
        self.assertEqual(names, [p.slug for p in products])


class MatteTests(unittest.TestCase):
    def test_cuts_product_out_of_white_packshot(self):
        alpha = sp.extract_matte(packshot())
        self.assertIsNotNone(alpha)
        self.assertEqual(alpha.shape[:2], (400, 300))
        # middle of the product is opaque, the border is transparent
        self.assertEqual(alpha[200, 150], 255)
        self.assertEqual(alpha[5, 5], 0)
        # bounding box of the alpha matches the pasted rectangle
        ys, xs = np.nonzero(alpha)
        self.assertGreaterEqual(ys.min(), 55)
        self.assertLessEqual(ys.max(), 344)

    def test_rejects_busy_background(self):
        rng = np.random.default_rng(0)
        noisy = rng.integers(0, 255, (400, 300, 3), dtype=np.uint8)
        self.assertIsNone(sp.extract_matte(noisy))

    def test_rejects_image_without_subject(self):
        self.assertIsNone(sp.extract_matte(np.full((400, 300, 3), 255, dtype=np.uint8)))

    def test_keeps_white_detail_inside_product(self):
        img = packshot(product=(200, 30, 30))  # red packet on white
        img[180:220, 120:180] = (255, 255, 255)  # white logo inside the packet
        alpha = sp.extract_matte(img)
        self.assertIsNotNone(alpha)
        self.assertEqual(alpha[200, 150], 255)  # white logo survives as product
        self.assertEqual(alpha[5, 5], 0)  # background around it does not

    def test_cutout_is_cropped_rgba(self):
        shot = sp.cutout(Image.fromarray(packshot()))
        self.assertIsNotNone(shot)
        self.assertEqual(shot.mode, "RGBA")
        self.assertLess(max(shot.size), 701)
        self.assertLess(shot.width, 300)  # trimmed to the product bounding box


class DedupeTests(unittest.TestCase):
    def test_hash_marks_near_identical_images_as_similar(self):
        a = Image.fromarray(packshot())
        b = Image.fromarray(packshot(margin=61))
        self.assertTrue(sp.similar(sp.dhash(a), sp.dhash(b)))

    def test_different_products_are_not_similar(self):
        a = Image.fromarray(packshot(product=(220, 40, 40)))
        blank = Image.new("L", (300, 400), 255)
        self.assertFalse(sp.similar(sp.dhash(a), sp.dhash(blank)))


class SearchFilterTests(unittest.TestCase):
    def _kept(self, titles):
        results = [
            {"image": f"https://cdn.example.com/{i}.jpg", "title": t}
            for i, t in enumerate(titles)
        ]
        return sp.ordered_candidates(results)

    def test_rejects_multipack_listing_titles(self):
        bad = [
            "Thums Up Can Pack of 6",
            "Pepsi 300ml 6x300ml Cans",
            "KitKat 4 pack value",
            "Maggi Masala Noodles (12)",
            "Sprite Zero 6 Cans",
            "Britannia Bourbon Bundle of 3",
        ]
        self.assertEqual(self._kept(bad), [])

    def test_keeps_single_unit_titles(self):
        good = [
            "Parle-G Glucose Biscuits 800g Family Pack",
            "Cadbury Dairy Milk Chocolate Bar 55g",
            "Maggi 2 Minute Noodles Masala 70g",
            "Britannia Good Day Cashew Cookies",
        ]
        self.assertEqual(len(self._kept(good)), len(good))


class BoxesTests(unittest.TestCase):
    def test_box_roundtrip(self):
        boxes = [(3, 100.0, 100.0, 300.0, 500.0)]
        lines = sp.box_lines(boxes, 1000, 1000)
        back = []
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.txt"
            p.write_text("\n".join(lines) + "\n")
            back = sp.read_boxes(p, 1000, 1000)
        self.assertEqual(len(back), 1)
        cls, x0, y0, x1, y1 = back[0]
        self.assertEqual(cls, 3)
        for got, want in zip((x0, y0, x1, y1), (100, 100, 300, 500)):
            self.assertAlmostEqual(got, want, places=3)

    def test_overlap_detection(self):
        a = (0, 0.0, 0.0, 100.0, 100.0)
        self.assertTrue(sp.overlaps(a, (1, 50.0, 50.0, 200.0, 200.0)))
        self.assertFalse(sp.overlaps(a, (1, 150.0, 150.0, 200.0, 200.0)))
        # a hairline sliver is tolerated so packets may sit edge to edge
        self.assertFalse(sp.overlaps(a, (1, 99.0, 99.0, 200.0, 200.0)))


class PasteTests(unittest.TestCase):
    def test_paste_lands_in_a_free_spot(self):
        rng = random.Random(7)
        bg = Image.new("RGB", (1200, 1600), (180, 170, 150))
        shot = Image.fromarray(
            np.dstack([packshot(), np.full((400, 300), 255, dtype=np.uint8)])
        )
        occupied = [(0, 100.0, 100.0, 500.0, 600.0)]  # a real object already there
        out, box = sp.paste_product(bg, shot, occupied, 5, rng)
        self.assertIsNotNone(box)
        cls, x0, y0, x1, y1 = box
        self.assertEqual(cls, 5)
        self.assertGreaterEqual(x0, 0)
        self.assertGreaterEqual(y0, 0)
        self.assertLessEqual(x1, bg.width)
        self.assertLessEqual(y1, bg.height)
        # never placed over the pre-existing box
        self.assertFalse(sp.overlaps(box, occupied[0]))
        self.assertNotEqual(out.tobytes(), bg.tobytes())

    def test_returns_none_when_frame_is_full(self):
        rng = random.Random(7)
        bg = Image.new("RGB", (400, 400), (180, 170, 150))
        shot = Image.fromarray(
            np.dstack([packshot(w=360, h=360, margin=10), np.full((360, 360), 255, dtype=np.uint8)])
        )
        occupied = [(0, 0.0, 0.0, 400.0, 400.0)]
        out, box = sp.paste_product(bg, shot, occupied, 1, rng)
        self.assertIsNone(box)
        self.assertEqual(out.tobytes(), bg.tobytes())


class ScheduleTests(unittest.TestCase):
    def test_respects_instance_counts_and_capacity(self):
        rng = random.Random(3)
        plan = sp.schedule(4, [10, 20, 0, 5], backgrounds=20, max_per_image=2, rng=rng)
        self.assertEqual(len(plan), 20)
        self.assertTrue(all(len(bg) <= 2 for bg in plan))
        flat = [pid for bg in plan for pid in bg]
        self.assertEqual(flat.count(0), 10)
        self.assertEqual(flat.count(1), 20)
        self.assertEqual(flat.count(2), 0)
        self.assertEqual(flat.count(3), 5)

    def test_never_exceeds_total_capacity(self):
        rng = random.Random(3)
        plan = sp.schedule(2, [100, 100], backgrounds=3, max_per_image=2, rng=rng)
        self.assertLessEqual(sum(len(bg) for bg in plan), 6)


class BackgroundSelectionTests(unittest.TestCase):
    def test_only_keeps_photos_labelled_with_local_classes(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for subset in ("train", "val"):
                (root / "images" / subset).mkdir(parents=True)
                (root / "labels" / subset).mkdir(parents=True)

            def add(subset, stem, label):
                Image.new("RGB", (64, 64), (1, 2, 3)).save(
                    root / "images" / subset / (stem + ".jpg")
                )
                (root / "labels" / subset / (stem + ".txt")).write_text(label)

            add("train", "own_shelf", "0 0.5 0.5 0.2 0.2\n3 0.2 0.2 0.1 0.1\n")
            # a frame labelled with a class outside the catalog must be skipped
            add("train", "foreign_shelf", "81 0.5 0.5 0.2 0.2\n")
            add("val", "own_shelf", "1 0.5 0.5 0.2 0.2\n")  # duplicate stem

            picked = sp.load_backgrounds(root, allowed_ids={0, 1, 2, 3})
            self.assertEqual([p.name for p, _ in picked], ["own_shelf.jpg"])


if __name__ == "__main__":
    unittest.main()
