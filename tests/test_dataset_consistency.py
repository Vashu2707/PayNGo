"""Cross-check the web product catalog against the YOLO dataset class list.

web/lib/products.ts keys the cart UI, the Mongo product seed and the
server-side checkout total, so every class in cv-ml-core/data/dataset-v2.yaml
must have an entry there (an unpriced class makes checkout reject the cart).

Run from the project root (inside the venv):

    python -m unittest discover -s tests -v
"""

import re
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
DATASET_YAML = ROOT / "cv-ml-core" / "data" / "dataset-v2.yaml"
CATALOG_TS = ROOT / "web" / "lib" / "products.ts"


def load_dataset_classes():
    """{class_id: class_name} from dataset-v2.yaml, in class-id order."""
    names = yaml.safe_load(DATASET_YAML.read_text(encoding="utf-8"))["names"]
    return {int(i): str(n) for i, n in names.items()}


def catalog_source():
    return CATALOG_TS.read_text(encoding="utf-8")


def catalog_slugs():
    """Class names listed in the CLASS_NAMES array of products.ts."""
    block = re.search(
        r"export const CLASS_NAMES: string\[\] = \[(.*?)\];", catalog_source(), re.S
    )
    assert block, "CLASS_NAMES array not found in web/lib/products.ts"
    return re.findall(r'"([^"]+)"', block.group(1))


def record_keys(source, declaration):
    """Keys of a `const NAME: ... = { "key": ... };` object literal."""
    block = re.search(re.escape(declaration) + r"\s*=\s*\{(.*?)\};", source, re.S)
    assert block, f"{declaration} not found in web/lib/products.ts"
    return re.findall(r'^\s*"([^"]+)":', block.group(1), re.M)


def default_price():
    match = re.search(r"const DEFAULT_PRICE = (\d+);", catalog_source())
    assert match, "DEFAULT_PRICE not found in web/lib/products.ts"
    return int(match.group(1))


class CatalogConsistencyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.classes = load_dataset_classes()
        cls.source = catalog_source()

    def test_class_ids_are_contiguous(self):
        """Ids must be 0..N-1 — smart_shelf.py and per-class flags index them."""
        self.assertEqual(sorted(self.classes), list(range(len(self.classes))))

    def test_catalog_lists_every_class_in_id_order(self):
        """CLASS_NAMES must mirror dataset-v2.yaml exactly (order == class id)."""
        expected = [self.classes[i] for i in sorted(self.classes)]
        actual = catalog_slugs()
        missing = [n for n in expected if n not in actual]
        extra = [n for n in actual if n not in expected]
        self.assertEqual(missing, [], f"classes missing from products.ts: {missing}")
        self.assertEqual(extra, [], f"slugs in products.ts unknown to dataset-v2.yaml: {extra}")
        self.assertEqual(actual, expected, "CLASS_NAMES order no longer matches class ids")

    def test_every_class_is_priced(self):
        """Checkout refuses a zero total, so each class needs a positive price."""
        self.assertGreater(default_price(), 0, "DEFAULT_PRICE must be positive")
        for slug in catalog_slugs():
            override = re.search(
                re.escape(f'"{slug}": {{ label: "') + r'[^"]*", price: (\d+)\s*\}',
                self.source,
            )
            if override:
                self.assertGreater(
                    int(override.group(1)), 0, f"override price for {slug} must be positive"
                )

    def test_overrides_reference_known_classes(self):
        known = set(self.classes.values())
        for field in ("const OVERRIDES: Record<string, Partial<ProductInfo>>", 
                      "const EMOJI_OVERRIDES: Record<string, string>"):
            unknown = [k for k in record_keys(self.source, field) if k not in known]
            self.assertEqual(unknown, [], f"{field} has unknown classes: {unknown}")


if __name__ == "__main__":
    unittest.main()
