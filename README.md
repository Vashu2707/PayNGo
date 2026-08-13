# PayNGo — Smart Shelf Checkout

A webcam is mounted above a shelf. Products placed on the shelf are detected in real time with a custom-trained **YOLOv10** model. When a customer **picks** an item off the shelf it is added to the cart; when the item is **placed back**, it is struck from the cart. The cart is stored in **MongoDB** and displayed on a simple **Next.js** web page (single-user, no auth).

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

## Repository layout

| Path | What it is |
|------|------------|
| `smart_shelf.py` | **Local CV app** — camera, detection, tracking, pick/place events, MongoDB sync |
| `train.py` | Trains the YOLOv10 model on the custom product dataset |
| `test_model.py`, `test_images.py` | Model evaluation / visualization helpers |
| `cv-ml-core/data/` | Dataset (images + labels) and `dataset.yaml` class config |
| `web/` | **Next.js UI** |
| `yolov10n.pt` | Pretrained YOLOv10 baseline weights |

Trained weights live under `runs/` (best run: `runs/detect/runs/train/product-detection-v1-3/weights/best.pt`, ~89% mAP50 on 4 product classes).

---

## 1. Local CV app (`smart_shelf.py`)

Runs on the machine with the webcam. Detects and tracks each product instance and decides:

- **PICK** — a tracked item disappears for `--removal` frames → cart quantity **+1** for that product.
- **PLACE** — a brand-new item appears and stays stable for `--stability` frames → cart quantity **−1**.
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

Press `q` to quit the camera window.

### MongoDB config

Point `MONGO_URI` at any MongoDB (local or Atlas). For local development:

```bash
# Docker
docker run -d -p 27017:27017 mongo:7

# brew
brew tap mongodb/brew && brew install mongodb-community
brew services start mongodb-community
```

```
MONGO_URI=mongodb://localhost:27017
MONGO_DB=payngo
```

---

## 2. Web UI (`web/`)

A single page that polls `/api/cart` every 1.5 s and shows the live cart, total item count, and a Live/Offline indicator (the camera app heartbeats the DB every 2 s). Includes a **Clear cart** button and a recent-activity feed.

### Run locally

```bash
cd web
npm install
cp .env.local.example .env.local    # already points at local MongoDB
npm run dev                         # http://localhost:3000
```

The UI reads and the camera app writes the same local MongoDB — that's the only connection between them.

---

## 3. Everything together (3 terminals)

1. **Start MongoDB**
   ```bash
   # Docker
   docker run -d --name payngo-mongo -p 27017:27017 mongo:7
   # or Homebrew
   brew tap mongodb/brew && brew install mongodb-community && brew services start mongodb-community
   ```
2. **Start the UI** → `cd web && npm run dev` → http://localhost:3000
3. **Start the camera** → `python smart_shelf.py --display` → pick items off the shelf and watch the cart fill in the browser.

---

## 4. Train on a new product

Add product images under `cv-ml-core/data/raw-images/<product>/`, label them, update `cv-ml-core/data/dataset.yaml`, then:

```bash
python train.py --weights yolov10n.pt --data cv-ml-core/data/dataset.yaml --epochs 20 --batch 16
```

Results are saved under `runs/train/`. `smart_shelf.py` automatically picks the newest `best.pt`.

---

## FAQ / tuning

- **False picks when a product is partially occluded** — raise `--removal` (frames it must be gone) or `--conf`.
- **Placed item not removed from cart** — raise `--stability`; the item must be consistently visible for that many frames.
- **Cart goes negative** — it is clamped at 0; this happens if more product is *added* to the shelf than was picked. The intended flow is pick → (place back) → clear.
