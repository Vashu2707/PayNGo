# PayNGo — Smart Shelf Checkout

A webcam is mounted above a shelf. Products placed on the shelf are detected in real time with a custom-trained **YOLOv10** model. When a customer **picks** an item off the shelf it is added to the cart; when the item is **placed back**, it is struck from the cart. The cart — with per-product **prices and a running total** — is stored in **MongoDB** and displayed on a **Next.js** web page (single-user, no auth).

Everything runs locally — no Vercel, no cloud.

```
                    ┌───────────────────────────────┐
                    │  Terminal 1 — Local device     │
                    │  smart_shelf.py                │
                    │  ┌───────────┐   ┌───────────┐ │
   webcam on shelf ──▶│ YOLOv10    │──▶│ pick/place │ │
                    │  │ tracking  │   │ detection │ │
                    │  └───────────┘   └─────┬─────┘ │
                    └────────────────────────┼───────┘
                                             │ pymongo (writes)
                                             ▼
                                      ┌─────────────┐
                                      │  MongoDB    │  local, port 27017
                                      └──────┬──────┘
                                             │ reads
                                      ┌──────▼──────┐
                                      │ Next.js UI  │  Terminal 2 — localhost:3000
                                      └─────────────┘
```

## Features

- Real-time detection + tracking (YOLOv10 + ByteTrack) with warm-up baseline, so shelf contents at startup never fire events.
- **PICK / PLACE** events with debouncing (`--stability` / `--removal`) to reject flicker.
- Live cart UI: quantities, per-line prices, grand total, recent-activity feed with relative timestamps, Live/Offline badge.
- Prices live in [`web/lib/products.ts`](web/lib/products.ts) — add a product there after training it.
- **Remote clear sync**: "Clear cart" in the web UI bumps a version counter; a running `smart_shelf.py` notices within ~2 s and resets its own cart, so both sides agree.
- Health endpoint at `/api/health` for a quick DB liveness check.
- Unit-tested event logic (`event_detector.py` is pure Python — no cv2 needed to test).

## Repository layout

| Path | What it is |
|------|------------|
| `smart_shelf.py` | **Local CV app** — camera, detection, tracking, pick/place events, MongoDB sync |
| `event_detector.py` | Pure pick/place → cart-event logic (unit-testable, no cv2 import) |
| `tests/` | Stdlib-`unittest` tests for the event logic |
| `train.py` | Trains the YOLOv10 model on the custom product dataset |
| `test_model.py`, `test_images.py` | Model evaluation / visualization helpers |
| `app.py` | Demo script — dual-model view (custom products green, other objects red) |
| `cv-ml-core/data/` | Dataset (images + labels) and `dataset.yaml` class config |
| `web/` | **Next.js UI** (cart page + `/api/cart`, `/api/events`, `/api/health`) |
| `yolov10n.pt` | Pretrained YOLOv10 baseline weights |

Trained weights live under `runs/`. By default all scripts pick the newest
`runs/**/weights/best.pt`; pass `--weights` to override.

---

## 1. Local CV app (`smart_shelf.py`)

Runs on the machine with the webcam. Detects and tracks each product instance and decides:

- **PICK** — a tracked item disappears for `--removal` frames → cart quantity **+1** for that product.
- **PLACE** — a brand-new item appears and stays stable for `--stability` frames → cart quantity **−1** (clamped at 0).
- The first `--warmup` seconds build a baseline of the loaded shelf, so events never fire at startup.

### Setup (Python 3.9+, macOS/Windows/Linux)

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

cp .env.example .env    # set MONGO_URI (see below)
```

### Run

Always run from the project virtual environment — using the system `python3` will
miss the project dependencies (e.g. `lap`, `pymongo`).

```bash
source venv/bin/activate     # or: .\venv\Scripts\activate on Windows

python smart_shelf.py --display          # show the live annotated view
python smart_shelf.py --camera 1 --conf 0.45
python smart_shelf.py --no-mongo         # local-only (no DB needed)
```

Press `q` to quit the camera window (or Ctrl+C). The final cart is printed on exit.

### MongoDB config

Point `MONGO_URI` at any MongoDB (local or Atlas). For local development:

```bash
# Docker
docker run -d -p 27017:27017 mongo:7

# brew
brew tap mongodb/brew && brew install mongodb-community
brew services start mongodb-community
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `MONGO_URI` | — (required unless `--no-mongo`) | MongoDB connection string |
| `MONGO_DB` | `payngo` | Database name |

---

## 2. Web UI (`web/`)

A single page that polls `/api/cart` every 1.5 s and shows the live cart with prices, total item count, **grand total**, and a Live/Offline indicator (the camera app heartbeats the DB every 2 s). Polling pauses while the tab is hidden. Includes a **Clear cart** button and a recent-activity feed.

### Run locally

```bash
cd web
npm install
cp .env.local.example .env.local    # already points at local MongoDB
npm run dev                         # http://localhost:3000
```

| Variable | Purpose |
|----------|---------|
| `MONGODB_URI` | MongoDB connection string used by the API routes |

The UI reads and the camera app writes the same local MongoDB — that's the only connection between them.

### Adding / pricing products

Class names come from `cv-ml-core/data/dataset.yaml`. Map each class to a label
and price in `web/lib/products.ts`; unknown products still appear but are
excluded from the total until priced.

---

## 3. Everything together (1 command)

```bash
./dev.sh
```

That single script starts MongoDB (only if it isn't already running), installs
web dependencies on first run, launches the Next.js UI at http://localhost:3000,
and runs the camera app with `--display`. Quitting the camera app (press `q` or
Ctrl+C) also stops the web server. Extra arguments are passed to
`smart_shelf.py`, e.g. `./dev.sh --camera 1 --conf 0.45` — and
`./dev.sh --no-mongo` skips MongoDB entirely.

Prefer manual control? The old 3-terminal way:

1. **Start MongoDB**
   ```bash
   # Docker
   docker run -d --name payngo-mongo -p 27017:27017 mongo:7
   # or Homebrew
   brew tap mongodb/brew && brew install mongodb-community && brew services start mongodb-community
   ```
2. **Start the UI** → `cd web && npm run dev` → http://localhost:3000
3. **Start the camera** → `python smart_shelf.py --display` → pick items off the shelf and watch the cart fill in the browser.

Sanity checks:

- `curl localhost:3000/api/health` → `{"ok":true,"db":"up",...}`

---

## 4. Train on a new product

Add product images under `cv-ml-core/data/raw-images/<product>/`, label them, update `cv-ml-core/data/dataset.yaml`, then:

```bash
python train.py --weights yolov10n.pt --data cv-ml-core/data/dataset.yaml --epochs 20 --batch 16
```

Results are saved under `runs/train/`. `smart_shelf.py` automatically picks the newest `best.pt`.

## 5. Tests & checks

```bash
# Event-detection unit tests (fast, no camera/cv2 needed)
source venv/bin/activate
python -m unittest discover -s tests -v

# Web type-check + production build
cd web && npx tsc --noEmit && npm run build
```

---

## FAQ / tuning

- **False picks when a product is partially occluded** — raise `--removal` (frames it must be gone) or `--conf`.
- **Placed item not removed from cart** — raise `--stability`; the item must be consistently visible for that many frames.
- **Cart goes negative** — it is clamped at 0; this happens if more product is *added* to the shelf than was picked. The intended flow is pick → (place back) → clear.
- **I pressed "Clear cart" but the shelf app re-added items** — it shouldn't anymore: the clear bumps a version counter that the shelf app polls (~every 2 s) and resets accordingly. If the shelf app is offline, its stale in-memory cart will overwrite the clear on its next change — just clear again after restarting it.
