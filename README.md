# PayNGo — Smart Shelf Checkout

A webcam is mounted above a shelf. Products placed on the shelf are detected in real time with a custom-trained **YOLOv10** model (113 product classes). When a customer **picks** an item off the shelf it is added to the cart; when the item is **placed back**, it is struck from the cart. The cart — with per-product **prices and a running total** — is stored in **MongoDB** and shown on a **Next.js** web app with a live **POS storefront**, an auth-protected **dashboard** (sales analytics + stock management), and a checkout flow supporting **Cash, UPI and online card payments (Razorpay)**.

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
- **Staff accounts**: first-run owner setup, then login-protected dashboard & checkout (bcrypt-hashed passwords, hashed session tokens, login rate-limiting).
- **Dashboard** (`/dashboard`): revenue stats, daily-sales chart, per-product stock bars with **restock**, stock-activity feed, recent transactions, low-stock warnings.
- **Checkout** (`/checkout`): Cash (recorded on the spot) or **UPI / Card via Razorpay** (server-side order creation + signature/webhook/server-API verification; the payment is only marked paid after the server confirms it, and stock is decremented exactly once).
- Sales automatically decrement inventory stock and feed the analytics (auditable per-transaction stock history).
- **Remote clear sync**: "Clear cart" in the web UI bumps a version counter; a running `smart_shelf.py` notices within ~2 s and resets its own cart, so both sides agree.
- Health endpoint at `/api/health` for a quick DB liveness check.
- Unit-tested event logic (`event_detector.py` is pure Python — no cv2 needed to test).

## Repository layout

| Path | What it is |
|------|------------|
| `smart_shelf.py` | **Local CV app** — camera, detection, tracking, pick/place events, MongoDB sync |
| `event_detector.py` | Pure pick/place → cart-event logic (unit-testable, no cv2 import) |
| `tests/` | Stdlib-`unittest` tests — pick/place event logic + dataset ↔ product-catalog consistency |
| `ingest_holoselecta.py` | Merges the HoloSelecta VOC zip into the dataset (XML → YOLO labels, appends the new classes to `dataset.yaml`) |
| `train.py` | Trains the YOLOv10 model on the 113-class product dataset |
| `train_supervisor.py` | Keeps a training run alive across Apple-Silicon MPS OOM crashes (auto-restart + per-epoch trainer recycle) |
| `resume_fast.py` | Restart a run at a smaller `imgsz`/`batch` to go faster with less memory |
| `prepare_dataset.py` | Class-stratified **train/val splitter + dataset analyzer** (run before training for honest metrics) |
| `test_model.py`, `test_images.py` | Model evaluation (mAP / per-class AP, precision/recall) / visualization helpers |
| `app.py` | Demo script — dual-model view (custom products green, other objects red) |
| `cv-ml-core/data/` | `dataset.yaml` (113 classes, tracked) + images/labels (git-ignored, multi-GB) |
| `web/` | **Next.js app** — POS storefront + login, `/dashboard`, `/checkout`, and `api/cart`, `api/events`, `api/health`, `api/transactions`, `api/checkout`, `api/analytics`, `api/inventory`, `api/auth/*`, `api/payments/*` |
| `yolov10n.pt` | Pretrained YOLOv10 baseline weights |

Trained weights live under `runs/`. By default all scripts (including `train.py`)
pick the newest `runs/**/weights/best.pt`; pass `--weights` to override.
Current best run: **`product-detection-v5`** (a 30-epoch fine-tune of v4 — 60
epochs in the lineage — mAP50 0.302 / mAP50-95 0.204 on the 113-class holdout).

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

Four pages, sharing one local MongoDB:

| Page | URL | Access |
|------|-----|--------|
| **POS storefront** | `/` | Public — live cart + recent transactions |
| **Login / first-run setup** | `/login` | Public — creates the owner account on first run, then signs in |
| **Dashboard** | `/dashboard` | Auth — analytics, inventory + restock, stock activity, transactions |
| **Checkout** | `/checkout` | Auth — pay cart with Cash / UPI / Card (Razorpay) |

The storefront polls `/api/cart` every 1.5 s (pausing while the tab is hidden) and
shows a Live/Offline badge (the camera app heartbeats the DB every 2 s).
Checkout on the storefront redirects to the auth-protected `/checkout` page.

### Run locally

```bash
cd web
npm install
cp .env.local.example .env.local    # MONGODB_URI already points at local MongoDB
npm run dev                         # http://localhost:3000
```

First visit: create the owner account on `/login`, then open `/dashboard` → **Set up
inventory** with an opening stock to seed the products collection. Re-run it
whenever the product catalog grows (it adds missing products and leaves existing
stock alone unless you tick **reset**).

| Variable | Purpose |
|----------|---------|
| `MONGODB_URI` | MongoDB connection string used by the API routes |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | (optional) enable online **Card** payments |
| `RAZORPAY_WEBHOOK_SECRET` | (optional) verify Razorpay webhook events |

The UI reads and the camera app writes the same local MongoDB — that's the only connection between them.

### Online card payments (Razorpay)

To enable the **Card** method on `/checkout`:

1. Create a Razorpay account (test mode is fine) and put the key id / secret in
   `web/.env.local`.
2. Verify order & signature server-side — already wired in
   `api/payments/create-order` and `api/payments/verify`.
3. Optional but recommended: set `RAZORPAY_WEBHOOK_SECRET` and register
   `api/payments/webhook` with an internet-reachable tunnel so a payment is
   finalized even if the customer closes the browser before verification.

Without these keys the dashboard still works; online checkout is disabled and only Cash is offered.

### Adding / pricing products

Class names come from `cv-ml-core/data/dataset.yaml` (113 classes) and
`web/lib/products.ts` ships a catalog entry for **every one of them** — label,
price, cart emoji. After editing the dataset, run
`python -m unittest discover -s tests` to confirm the catalog still covers
every class, then update the affected entry (labels are derived from the class
name; prices for new classes default to a placeholder ₹10 — replace them
before going live, since checkout refuses a zero total). Unknown products still
appear in the cart but are excluded from the total until priced.

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

Add product images under `cv-ml-core/data/raw-images/<product>/`, label them, update `cv-ml-core/data/dataset.yaml`, then rebuild a class-balanced train/val split and train:

```bash
source venv/bin/activate

# Stratified split — gives the val set the same class mix as training
python prepare_dataset.py --data cv-ml-core/data/dataset.yaml --analyze   # inspect first (optional)
python prepare_dataset.py --data cv-ml-core/data/dataset.yaml --val-ratio 0.2 --seed 42

python train.py --data cv-ml-core/data/dataset.yaml --epochs 60 --batch 16 --imgsz 960
# optional: --weights yolov10n.pt to start from the pretrained baseline
#           (default is the newest runs/**/weights/best.pt, i.e. fine-tuning)
```

Results are saved under `runs/` (ultralytics nests them, e.g.
`runs/detect/runs/train/<name>`). `smart_shelf.py` automatically picks the newest `best.pt`.
Measure accuracy on the holdout with `python test_model.py` (reports mAP, per-class AP, precision/recall).

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
