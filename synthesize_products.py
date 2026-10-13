#!/usr/bin/env python3
"""Build an in-domain YOLO dataset from web packshots + your own shelf photos.

The dataset that ships with the repo (`dataset.yaml`) contains only the four
Lays chip flavours you photographed on your own shelf. This script builds the
rest of the catalog from catalog.yaml instead:

  search  find packshots (web images of the actual packaging) for every
          query in the catalog, cut the product out of its background and
          store the cutout under cv-ml-core/data/packshots/<slug>/.
  build   paste those cutouts onto real photos of your own shelf (the ones
          in yolo-dataset, whose labels only contain classes 0..3) and emit
          images + YOLO labels + dataset-v2.yaml under yolo-v2-dataset/.

Why this works: packaging artwork is fixed, so a web packshot is visually
identical to the packet on your shelf — the only thing a web photo lacks is
your camera and lighting, and your own shelf photos supply that.

Typical run:

  python synthesize_products.py search --per-product 12
  python synthesize_products.py build --instances-per-product 150
  python prepare_dataset.py --source cv-ml-core/data/yolo-v2-dataset \\
      --data cv-ml-core/data/dataset-v2.yaml
  python train.py --data cv-ml-core/data/dataset-v2.yaml --weights yolov10n.pt

Notes
  * Products are never mirrored horizontally — a flipped packet has its
    brand name backwards.
  * Paste positions that would collide with an already-labelled object are
    rejected, so the real detections in the source photos stay correct.
  * `build` only uses source images whose labels are a subset of 0..3
    (your own photos); anything else is skipped, because those frames
    show products this catalog does not sell.
"""

from __future__ import annotations

import argparse
import io
import random
import re
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
import requests
import yaml
from PIL import Image, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parent
DEFAULT_CATALOG = ROOT / "catalog.yaml"
DEFAULT_PACKSHOTS = ROOT / "cv-ml-core" / "data" / "packshots"
DEFAULT_SOURCE = ROOT / "cv-ml-core" / "data" / "yolo-dataset"
DEFAULT_OUT = ROOT / "cv-ml-core" / "data" / "yolo-v2-dataset"
DEFAULT_DATA = ROOT / "cv-ml-core" / "data" / "dataset-v2.yaml"

# Class ids the labels in the existing dataset use for your own photos.
# Any product marked `source: existing` must occupy one of these ids.
EXISTING_SLUGS = ("blue-lays", "green-lays", "orange-lays", "dark-green-lays")

IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
MIN_PACKSHOT_PX = 260
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
# Hosts that reliably serve white-background packshots rather than lifestyle
# shots. They get offered to the downloader first; anything else is a fallback.
PREFERRED_HOSTS = (
    "m.media-amazon.com",
    "bigbasket.com",
    "jiomart",
    "flipkart.com",
    "1mg.com",
    "dmart",
    "grofers",
    "zepto",
    "swiggyinstamart",
    "blinkit",
)


# --------------------------------------------------------------------------- #
# catalog
# --------------------------------------------------------------------------- #
@dataclass
class Product:
    slug: str
    label: str
    price: int
    source: str = "web"  # "web" | "existing"
    queries: list[str] = field(default_factory=list)
    urls: list[str] = field(default_factory=list)


def load_catalog(path: Path) -> list[Product]:
    cfg = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    rows = cfg.get("products") or []
    if not rows:
        sys.exit(f"{path}: no products found")

    products: list[Product] = []
    seen: set[str] = set()
    for i, row in enumerate(rows):
        slug = str(row.get("slug") or "").strip()
        if not slug:
            sys.exit(f"{path}: product #{i} has no slug")
        if slug in seen:
            sys.exit(f"{path}: duplicate slug {slug!r}")
        seen.add(slug)
        queries = row.get("queries") or ([row["query"]] if row.get("query") else [])
        products.append(
            Product(
                slug=slug,
                label=str(row.get("label") or slug.replace("-", " ").title()),
                price=int(row.get("price") or 1),
                source=str(row.get("source") or "web"),
                queries=[str(q) for q in queries],
                urls=[str(u) for u in (row.get("urls") or [])],
            )
        )

    existing = [i for i, p in enumerate(products) if p.source == "existing"]
    if existing:
        if sorted(existing) != [0, 1, 2, 3]:
            sys.exit(
                "`source: existing` products must occupy ids 0..3 — the labels "
                "already on disk use those ids. Got "
                f"{[products[i].slug for i in existing]}."
            )
        got = tuple(products[i].slug for i in range(4))
        if got != EXISTING_SLUGS:
            sys.exit(
                "The first four products must stay in this exact order: "
                f"{list(EXISTING_SLUGS)}. Got {list(got)}."
            )
    return products


def dataset_yaml_text(products: list[Product]) -> str:
    lines = [
        "train: yolo-v2-dataset/images/train",
        "val: yolo-v2-dataset/images/val",
        "names:",
    ]
    lines += [f"  {i}: {p.slug}" for i, p in enumerate(products)]
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- #
# packshot matting
# --------------------------------------------------------------------------- #
def extract_matte(
    rgb: np.ndarray,
    *,
    border: int = 4,
    ref_tol: float = 28.0,
    ring_std_max: float = 18.0,
    min_area_frac: float = 0.02,
    max_area_frac: float = 0.97,
) -> np.ndarray | None:
    """Cut the product out of a packshot.

    Assumes the product sits on a near-uniform background (white, light grey,
    plain colour). The background is "the border colour, connected to the
    border" — anything enclosed by the product keeps its alpha, so white text
    on a white packet is not eaten.

    Returns a uint8 HxW alpha map, or None when the photo is not a clean
    packshot (busy background, product fills the frame, nothing to cut).
    """
    if rgb.ndim != 3 or rgb.shape[2] != 3:
        return None
    h, w = rgb.shape[:2]
    b = max(1, min(border, h // 4, w // 4))
    if min(h, w) < 60:
        return None

    ring = np.concatenate(
        [
            rgb[:b].reshape(-1, 3),
            rgb[-b:].reshape(-1, 3),
            rgb[:, :b].reshape(-1, 3),
            rgb[:, -b:].reshape(-1, 3)
        ]
    )
    ref = np.median(ring, axis=0)
    if float(ring.std(axis=0).max()) > ring_std_max:
        return None  # not a plain background

    diff = np.abs(rgb.astype(np.int16) - ref.astype(np.int16)).max(axis=2)
    near = (diff <= ref_tol).astype(np.uint8)
    num, labels = cv2.connectedComponents(near, connectivity=8)
    edge = np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
    edge_labels = np.unique(edge[edge > 0])
    if edge_labels.size == 0 or num <= 1:
        return None
    is_bg = np.isin(labels, edge_labels)

    # Swallow the light fringe that photographs leave around a cut product.
    halo = diff <= ref_tol + 10
    for _ in range(2):
        grown = cv2.dilate(is_bg.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
        is_bg = is_bg | (halo & grown)

    fg = ~is_bg
    area = float(fg.mean())
    if area < min_area_frac or area > max_area_frac:
        return None

    # Keep the product blob(s); specks are dust, reflections, or shadows.
    num_fg, fg_lab, stats, _ = cv2.connectedComponentsWithStats(fg.astype(np.uint8), 8)
    if num_fg < 2:
        return None
    areas = stats[1:, cv2.CC_STAT_AREA]
    keep = np.where(areas >= 0.15 * float(areas.max()))[0] + 1
    fg = np.isin(fg_lab, keep)
    if not fg.any() or float(fg.mean()) > max_area_frac:
        return None
    return fg.astype(np.uint8) * 255


def cutout(img: Image.Image, **kwargs) -> Image.Image | None:
    """matte + crop; returns an RGBA PIL image or None when rejected."""
    rgb = np.asarray(img.convert("RGB"))
    alpha = extract_matte(rgb, **kwargs)
    if alpha is None:
        return None
    ys, xs = np.nonzero(alpha)
    if ys.size == 0:
        return None
    y0, y1 = max(0, ys.min() - 2), min(alpha.shape[0], ys.max() + 3)
    x0, x1 = max(0, xs.min() - 2), min(alpha.shape[1], xs.max() + 3)
    rgba = np.dstack([rgb[y0:y1, x0:x1], alpha[y0:y1, x0:x1]])
    out = Image.fromarray(rgba)
    # Cutouts only ever get pasted at a fraction of the frame; store them small.
    if max(out.size) > 700:
        f = 700 / max(out.size)
        out = out.resize((max(1, int(out.width * f)), max(1, int(out.height * f))), Image.LANCZOS)
    return out


def dhash(img: Image.Image, size: int = 8) -> int:
    """Perceptual hash (difference hash). Plain ints keep dedupe comparisons exact."""
    g = img.convert("L").resize((size + 1, size), Image.LANCZOS)
    bits = np.asarray(g, dtype=np.int16)
    out = 0
    for r in range(size):
        for c in range(size):
            if bits[r, c + 1] > bits[r, c]:
                out |= 1 << (r * size + c)
    return out


def similar(a: int, b: int) -> bool:
    return bin(a ^ b).count("1") <= 6


# --------------------------------------------------------------------------- #
# search
# --------------------------------------------------------------------------- #
class RateLimited(Exception):
    """The image-search backend is throttling this IP for a while."""


def ddg_image_results(
    session: requests.Session,
    query: str,
    timeout: float = 20.0,
    retries: int = 2,
    backoff: tuple[float, ...] = (25.0, 60.0),
) -> list[dict]:
    """Public image-search endpoint. Returns [{image,width,height,title}].

    DuckDuckGo answers 403/202 when queries arrive in a burst; it recovers
    after a pause, so those statuses are retried with a cooldown instead of
    failing the product.
    """
    for attempt in range(retries + 1):
        page = session.get("https://duckduckgo.com/", params={"q": query}, timeout=timeout)
        if page.status_code in (202, 403, 429):
            if attempt < retries:
                wait = backoff[min(attempt, len(backoff) - 1)]
                print(f"    ! throttled by image search (HTTP {page.status_code}), waiting {wait:.0f}s")
                time.sleep(wait)
                continue
            raise RateLimited(f"image search throttled (HTTP {page.status_code})")
        m = re.search(r'vqd=["\']?([\d-]+)["\']?', page.text)
        if not m:
            raise RuntimeError("no vqd token")
        res = session.get(
            "https://duckduckgo.com/i.js",
            params={"l": "in-en", "o": "json", "q": query, "vqd": m.group(1), "f": ",,,", "p": "1"},
            headers={"Referer": "https://duckduckgo.com/"},
            timeout=timeout,
        )
        if res.status_code == 200:
            try:
                return res.json().get("results") or []
            except ValueError:
                return []
        if res.status_code in (202, 403, 429):
            if attempt < retries:
                wait = backoff[min(attempt, len(backoff) - 1)]
                print(f"    ! throttled by image search (HTTP {res.status_code}), waiting {wait:.0f}s")
                time.sleep(wait)
                continue
            raise RateLimited(f"image search throttled (HTTP {res.status_code})")
        return []
    return []


# Titles of e-commerce results that show several units at once (6-packs,
# trays, "pack of 6", combos). Those make wrong training boxes: the class is
# one unit, not a shrink-wrapped bundle.
MULTIPACK_TITLE = re.compile(
    r"""(
          pack\s+of\s*\d |
          set\s+of\s*\d |
          \d+\s*[x×]\s*\d+ |
          \b\d{1,2}\s*-?\s*packs?\b |
          (six|eight|ten|twelve|twenty[- ]four)\s*(packs?|cans?|bottles?) |
          multi[-\s]?pack |
          combo\s+(pack|deal|offer) |
          \bbundle\b |
          \bwholesale\b |
          bulk\s+pack |
          case\s+of\s*\d |
          \(\s*\d+\s*\) |
          \b\d+\s*(cans?|bottles?|pieces?)\b
       )""",
    re.I | re.X,
)


def ordered_candidates(results: list[dict]) -> list[str]:
    """Packshot CDNs first, everything else after, dead formats dropped."""
    urls: list[str] = []
    for r in results:
        u = str(r.get("image") or "")
        if not u.startswith(("http://", "https://")):
            continue
        if re.search(r"\.(gif|svg)(\?|$)", u, re.I) or "logo" in u.lower():
            continue
        title = str(r.get("title") or "")
        if title and MULTIPACK_TITLE.search(title):
            continue
        urls.append(u)
    ranked = sorted(urls, key=lambda u: 0 if any(h in u for h in PREFERRED_HOSTS) else 1)
    return list(dict.fromkeys(ranked))


def fetch_image(session: requests.Session, url: str, timeout: float = 20.0) -> Image.Image | None:
    try:
        resp = session.get(url, timeout=timeout, stream=True)
        if resp.status_code != 200:
            return None
        ctype = (resp.headers.get("content-type") or "").lower()
        if "image" not in ctype and "octet-stream" not in ctype:
            return None
        data = resp.raw.read(8 * 1024 * 1024, decode_content=True)
    except Exception:
        return None
    if len(data) < 6000:
        return None
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
        img = img.convert("RGB")
    except Exception:
        return None
    if min(img.size) < MIN_PACKSHOT_PX:
        return None
    return img


def existing_hashes(slug_dir: Path) -> set[int]:
    hashes = set()
    if not slug_dir.is_dir():
        return hashes
    for p in sorted(slug_dir.glob("*.png")):
        try:
            hashes.add(dhash(Image.open(p)))
        except Exception:
            pass
    return hashes


def save_cutout(img: Image.Image, slug_dir: Path, idx: int) -> Path:
    slug_dir.mkdir(parents=True, exist_ok=True)
    path = slug_dir / f"{idx:03d}.png"
    img.save(path, optimize=True)
    return path


def next_index(slug_dir: Path) -> int:
    nums = [int(p.stem) for p in slug_dir.glob("*.png") if p.stem.isdigit()]
    return (max(nums) + 1) if nums else 1


def collect_packshots(
    product: Product,
    slug_dir: Path,
    *,
    target: int,
    session: requests.Session,
    sleep: float,
    verbose: bool = True,
) -> int:
    """Download up to `target` accepted cutouts for one product.

    Queries and downloads are interleaved: the second query for a product only
    runs when the first one did not produce enough usable packshots, which keeps
    the total number of search calls (and the risk of being throttled) down.
    """
    have = len(list(slug_dir.glob("*.png"))) if slug_dir.is_dir() else 0
    if have >= target:
        return 0
    hashes = existing_hashes(slug_dir)
    idx = next_index(slug_dir)
    wanted = target - have
    accepted = 0

    def take(urls: list[str]) -> None:
        nonlocal idx, accepted
        for url in dict.fromkeys(urls):
            if accepted >= wanted:
                return
            img = fetch_image(session, url)
            if img is None:
                continue
            shot = cutout(img)
            if shot is None:
                continue
            h = dhash(shot)
            if any(similar(h, prev) for prev in hashes):
                continue
            save_cutout(shot, slug_dir, idx)
            hashes.add(h)
            idx += 1
            accepted += 1

    take(product.urls)  # hand-pasted URLs are free — no search call needed

    throttled = False
    for query in product.queries:
        if accepted >= wanted or throttled:
            break
        try:
            results = ddg_image_results(session, query)
        except RateLimited as exc:
            if verbose:
                print(f"    ! {exc} — using what we have for {product.slug}")
            throttled = True
            break
        except Exception as exc:
            if verbose:
                print(f"    ! search failed for {query!r}: {exc}")
            results = []
        take(ordered_candidates(results))
        if sleep:
            time.sleep(sleep + random.uniform(0.0, 1.5))

    if verbose:
        print(f"    {product.slug}: {have} -> {have + accepted} packshot(s)")
    return accepted


def run_search(args) -> None:
    products = [p for p in load_catalog(Path(args.catalog)) if p.source == "web"]
    if args.only:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        products = [p for p in products if p.slug in wanted]
        unknown = wanted - {p.slug for p in products}
        if unknown:
            sys.exit(f"--only names unknown products: {sorted(unknown)}")
    if not products:
        print("Nothing to search.")
        return

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT, "Accept-Language": "en-IN,en;q=0.9"})
    for product in products:
        print(f"  {product.slug}")
        collect_packshots(
            product,
            Path(args.packshots) / product.slug,
            target=args.per_product,
            session=session,
            sleep=args.sleep,
        )
    print(f"Done. Cutouts under {args.packshots}/<slug>/.")


# --------------------------------------------------------------------------- #
# build
# --------------------------------------------------------------------------- #
def load_backgrounds(source: Path, allowed_ids: set[int]) -> list[tuple[Path, Path]]:
    """(image, label) pairs for photos whose labels stay inside `allowed_ids`.

    These are your own shelf photos; any frame labelled with a class outside
    the allowed set is skipped.
    """
    out: list[tuple[Path, Path]] = []
    seen: set[str] = set()
    for subset in ("train", "val"):
        img_dir = source / "images" / subset
        if not img_dir.is_dir():
            continue
        for img in sorted(img_dir.iterdir()):
            if img.suffix.lower() not in IMG_EXTS or img.stem in seen:
                continue
            lbl = source / "labels" / subset / (img.stem + ".txt")
            if not lbl.exists():
                continue
            ids = {
                int(p[0])
                for line in lbl.read_text().splitlines()
                if (p := line.split())
            }
            if ids and ids <= allowed_ids:
                seen.add(img.stem)
                out.append((img, lbl))
    return out


def read_boxes(label_path: Path, w: int, h: int) -> list[tuple[int, float, float, float, float]]:
    """[(cls, x0, y0, x1, y1)] in pixels."""
    boxes = []
    for line in label_path.read_text().splitlines():
        p = line.split()
        if len(p) != 5:
            continue
        cls, cx, cy, bw, bh = int(p[0]), float(p[1]), float(p[2]), float(p[3]), float(p[4])
        boxes.append(
            (cls, (cx - bw / 2) * w, (cy - bh / 2) * h, (cx + bw / 2) * w, (cy + bh / 2) * h)
        )
    return boxes


def box_lines(boxes: list[tuple[int, float, float, float, float]], w: int, h: int) -> list[str]:
    lines = []
    for cls, x0, y0, x1, y1 in boxes:
        x0, x1 = max(0.0, x0), min(float(w), x1)
        y0, y1 = max(0.0, y0), min(float(h), y1)
        if x1 <= x0 or y1 <= y0:
            continue
        lines.append(
            f"{cls} {((x0 + x1) / 2) / w:.6f} {((y0 + y1) / 2) / h:.6f} "
            f"{(x1 - x0) / w:.6f} {(y1 - y0) / h:.6f}"
        )
    return lines


def overlaps(a, b, min_frac: float = 0.02) -> bool:
    """True when two boxes collide enough to matter.

    `min_frac` of the smaller box lets packets sit edge-to-edge (and ignores
    a hairline sliver) without letting a paste cover a real object.
    """
    ix0, iy0 = max(a[1], b[1]), max(a[2], b[2])
    ix1, iy1 = min(a[3], b[3]), min(a[4], b[4])
    if ix1 <= ix0 or iy1 <= iy0:
        return False
    inter = (ix1 - ix0) * (iy1 - iy0)
    smaller = min((a[3] - a[1]) * (a[4] - a[2]), (b[3] - b[1]) * (b[4] - b[2]))
    return smaller > 0 and inter > min_frac * smaller


def paste_product(
    bg: Image.Image,
    cutout_img: Image.Image,
    occupied: list[tuple[int, float, float, float, float]],
    cls: int,
    rng: random.Random,
    *,
    min_frac: float = 0.25,
    max_frac: float = 0.60,
    max_tries: int = 60,
    shadow: bool = True,
):
    """Place `cutout_img` on `bg` at a free spot.

    Returns (new_bg, box) or (bg, None) when no free spot was found.
    Rotates (never mirrors — the logo would read backwards), jitters colour
    to imitate your lighting, and drops a soft shadow under the packet.

    Size shrinks over successive attempts: their photos are close-ups where one
    real bag covers ~70% of the frame, so the leftover space is often a narrow
    strip. Trying one size would drop the instance (or crowd the frame); trying
    large first and backing off keeps both the big placements and the count.
    """
    w, h = bg.size
    aspect = cutout_img.height / max(1, cutout_img.width)
    size_cap = min((h * 0.9) / (aspect * 1.35), w * 0.92)
    margin = max(2, int(0.01 * min(w, h)))

    box = None
    shot = None
    for attempt in range(max_tries):
        hi = max(min_frac, max_frac - (max_frac - min_frac) * 1.4 * (attempt / max_tries))
        tw = int(min(rng.uniform(min_frac, hi) * w, size_cap))
        if tw < 24 or tw >= w * 0.95:
            continue
        th = max(24, int(tw * aspect))
        if th >= h * 0.95:
            continue
        cand_shot = cutout_img.resize((tw, th), Image.LANCZOS)
        cand_shot = cand_shot.rotate(
            rng.uniform(-9, 9), expand=True, resample=Image.BICUBIC, fillcolor=(0, 0, 0, 0)
        )
        cand_shot = ImageEnhance.Brightness(cand_shot).enhance(rng.uniform(0.9, 1.12))
        cand_shot = ImageEnhance.Contrast(cand_shot).enhance(rng.uniform(0.9, 1.1))
        cand_shot = ImageEnhance.Color(cand_shot).enhance(rng.uniform(0.9, 1.12))
        pw, ph = cand_shot.size
        if pw >= w - 2 * margin or ph >= h - 2 * margin:
            continue
        x = rng.randint(margin, w - pw - margin)
        y = rng.randint(margin, h - ph - margin)
        cand = (cls, float(x), float(y), float(x + pw), float(y + ph))
        if any(overlaps(cand, other) for other in occupied):
            continue
        box, shot = cand, cand_shot
        break
    if box is None or shot is None:
        return bg, None
    pw, ph = shot.size

    frame = bg.convert("RGBA")
    x, y = int(box[1]), int(box[2])
    if shadow:
        sil = Image.new("RGBA", frame.size, (0, 0, 0, 0))
        mask = shot.getchannel("A")
        offset = (x + max(2, pw // 24), y + max(2, ph // 14))
        sil.paste((0, 0, 0, int(120)), offset, mask)
        sil = sil.filter(ImageFilter.GaussianBlur(max(2, pw // 18)))
        frame = Image.alpha_composite(frame, sil)
    frame.alpha_composite(shot, (x, y))
    return frame.convert("RGB"), box


def schedule(
    n_products: int,
    instances: list[int],
    backgrounds: int,
    max_per_image: int,
    rng: random.Random,
) -> list[list[int]]:
    """Which product ids go on which background index.

    `instances[i]` pastes of product i are spread across distinct backgrounds,
    never exceeding `max_per_image` pastes on one photo. Returns a list of
    lists (background index -> product ids); a background may be empty.
    """
    tasks = []
    for pid, count in enumerate(instances):
        tasks.extend([pid] * count)
    rng.shuffle(tasks)

    capacity = max_per_image * backgrounds
    if len(tasks) > capacity:
        tasks = tasks[:capacity]

    per_bg: list[list[int]] = [[] for _ in range(backgrounds)]
    load = [0] * backgrounds
    order = list(range(backgrounds))
    for pid in tasks:
        rng.shuffle(order)
        placed = False
        for bg in order:
            if load[bg] < max_per_image:
                per_bg[bg].append(pid)
                load[bg] += 1
                placed = True
                break
        if not placed:
            break
    for bg in per_bg:
        rng.shuffle(bg)
    return per_bg


def run_build(args) -> None:
    products = load_catalog(Path(args.catalog))
    by_slug_index = {p.slug: i for i, p in enumerate(products)}
    rng = random.Random(args.seed)

    backgrounds = load_backgrounds(Path(args.source), allowed_ids=set(range(len(EXISTING_SLUGS))))
    if not backgrounds:
        sys.exit(f"No usable background photos under {args.source}")

    packshots_root = Path(args.packshots)
    cutouts: dict[int, list[Image.Image]] = {}
    for i, p in enumerate(products):
        if p.source == "existing":
            continue
        files = sorted((packshots_root / p.slug).glob("*.png"))
        if not files:
            print(f"  WARNING: {p.slug} has no packshots — run `search` for it first")
            cutouts[i] = []
            continue
        loaded = []
        for f in files:
            try:
                loaded.append(Image.open(f).convert("RGBA"))
            except Exception as exc:
                print(f"  WARNING: unreadable {f}: {exc}")
        cutouts[i] = loaded

    instances = [
        0 if p.source == "existing" else args.instances_per_product
        for p in products
    ]
    missing = [p.slug for i, p in enumerate(products) if p.source != "existing" and not cutouts.get(i)]
    if missing and not args.allow_missing:
        sys.exit(
            f"Products with no packshots: {missing}\n"
            "Run `python synthesize_products.py search` first, or pass "
            "--allow-missing to build anyway (those classes would be empty)."
        )

    plan = schedule(len(products), instances, len(backgrounds), args.max_per_image, rng)
    requested = sum(instances)
    placed = sum(len(bg) for bg in plan)
    if placed < requested:
        print(
            f"  NOTE: {requested} pastes requested but the backgrounds only hold "
            f"{placed} (max {args.max_per_image} per image). Raise "
            "--max-per-image, or use --instances-per-product to ask for fewer."
        )

    out_root = Path(args.out)
    for subset in ("train", "val"):
        for base in ("images", "labels"):
            d = out_root / base / subset
            d.mkdir(parents=True, exist_ok=True)
            for stale in d.iterdir():
                if stale.suffix.lower() in IMG_EXTS or stale.suffix == ".txt":
                    stale.unlink()

    counters: dict[int, int] = defaultdict(int)
    rejected = 0
    for (img_path, lbl_path), pids in zip(backgrounds, plan):
        img = Image.open(img_path).convert("RGB")
        if args.max_side and max(img.size) > args.max_side:
            f = args.max_side / max(img.size)
            img = img.resize((max(1, int(img.width * f)), max(1, int(img.height * f))), Image.LANCZOS)
        w, h = img.size
        boxes = read_boxes(lbl_path, w, h)

        for pid in pids:
            pool = cutouts.get(pid) or []
            if not pool:
                rejected += 1
                continue
            shot = pool[counters[pid] % len(pool)]
            img, box = paste_product(
                img,
                shot,
                boxes,
                pid,
                rng,
                min_frac=args.min_frac,
                max_frac=args.max_frac,
            )
            if box is None:
                rejected += 1
                continue
            boxes.append(box)
            counters[pid] += 1

        out_img = out_root / "images/train" / (img_path.stem + ".jpg")
        img.save(out_img, "JPEG", quality=90)
        (out_root / "labels/train" / (img_path.stem + ".txt")).write_text(
            "\n".join(box_lines(boxes, w, h)) + ("\n" if boxes else "")
        )

    # Backfill — a placement that fails (frame too crowded) is lost for that
    # product, which is what leaves classes short of their target count. Retry
    # short products on frames that still have room, so the class counts stay
    # close to even instead of depending on chance.
    failed: set[tuple[int, int]] = set()
    load = [len(p) for p in plan]
    order = list(range(len(backgrounds)))
    for pid in sorted(
        (i for i, p in enumerate(products) if p.source != "existing"),
        key=lambda i: counters[i] - instances[i],
    ):
        pool = cutouts.get(pid) or []
        need = instances[pid] - counters[pid]
        if not pool or need <= 0:
            continue
        rng.shuffle(order)
        attempts = 0
        for bg_i in order:
            if need <= 0 or attempts >= 400:
                break
            if load[bg_i] >= args.max_per_image or (pid, bg_i) in failed:
                continue
            attempts += 1
            out_img = out_root / "images/train" / (backgrounds[bg_i][0].stem + ".jpg")
            lbl_out = out_root / "labels/train" / (backgrounds[bg_i][0].stem + ".txt")
            img = Image.open(out_img).convert("RGB")
            w, h = img.size
            boxes = read_boxes(lbl_out, w, h)
            img, box = paste_product(
                img,
                pool[counters[pid] % len(pool)],
                boxes,
                pid,
                rng,
                min_frac=args.min_frac,
                max_frac=args.max_frac,
            )
            if box is None:
                failed.add((pid, bg_i))
                rejected += 1
                continue
            boxes.append(box)
            img.save(out_img, "JPEG", quality=90)
            lbl_out.write_text("\n".join(box_lines(boxes, w, h)) + "\n")
            load[bg_i] += 1
            counters[pid] += 1
            need -= 1

    Path(args.data).write_text(dataset_yaml_text(products), encoding="utf-8")

    print(f"\nWrote {len(backgrounds)} images to {out_root}/images/train")
    print(f"  placements rejected (no free spot): {rejected}")
    for i, p in enumerate(products):
        if p.source == "existing":
            note = "real photos (labels copied)"
            count = sum(
                1
                for (_, lbl) in backgrounds
                for line in lbl.read_text().splitlines()
                if line.split() and int(line.split()[0]) == i
            )
            print(f"  {p.slug:<26} {count:>5} instances  {note}")
        else:
            print(f"  {p.slug:<26} {counters[i]:>5} pasted instances")
    print(f"\nClass names written to {args.data}")
    print(
        "Next:\n"
        f"  python prepare_dataset.py --source {args.out} --data {args.data}\n"
        f"  python train.py --data {args.data} --weights yolov10n.pt"
    )
    if missing:
        print(f"WARNING: empty classes (no packshots): {missing}")


# --------------------------------------------------------------------------- #
# cli
# --------------------------------------------------------------------------- #
def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("search", help="download packshots for every product in the catalog")
    s.add_argument("--catalog", default=str(DEFAULT_CATALOG))
    s.add_argument("--packshots", default=str(DEFAULT_PACKSHOTS))
    s.add_argument("--per-product", type=int, default=12, help="accepted cutouts per product")
    s.add_argument("--only", default="", help="comma-separated slugs to (re)fetch")
    s.add_argument(
        "--sleep",
        type=float,
        default=4.0,
        help="seconds between search queries; raise it if searches start getting throttled",
    )
    s.set_defaults(func=run_search)

    b = sub.add_parser("build", help="paste cutouts onto your shelf photos -> YOLO dataset")
    b.add_argument("--catalog", default=str(DEFAULT_CATALOG))
    b.add_argument("--packshots", default=str(DEFAULT_PACKSHOTS))
    b.add_argument("--source", default=str(DEFAULT_SOURCE), help="dataset to use as backgrounds")
    b.add_argument("--out", default=str(DEFAULT_OUT))
    b.add_argument("--data", default=str(DEFAULT_DATA), help="dataset yaml to write")
    b.add_argument("--instances-per-product", type=int, default=150)
    b.add_argument("--max-per-image", type=int, default=2)
    b.add_argument("--min-frac", type=float, default=0.25, help="min pasted width / frame width")
    b.add_argument("--max-frac", type=float, default=0.60, help="max pasted width / frame width")
    b.add_argument("--max-side", type=int, default=1600, help="downscale frames to this long edge")
    b.add_argument("--seed", type=int, default=42)
    b.add_argument("--allow-missing", action="store_true", help="build even if some classes have no packshots")
    b.set_defaults(func=run_build)

    return p.parse_args(argv)


def main(argv=None) -> None:
    args = parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
