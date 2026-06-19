"""
Image Dataset Cleaner & Review Tool
Rainwater Labs Internship Assignment
Author: Astha
"""

import os
import json
import hashlib
import csv
import sqlite3
import zipfile
import io
import uuid
import logging
import mimetypes
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse, urljoin

import requests
from bs4 import BeautifulSoup
from PIL import Image
import imagehash
from flask import (
    Flask, render_template, request, jsonify,
    send_from_directory, send_file
)

# ── Config ────────────────────────────────────────────────────────────────────
BASE_DIR   = Path(__file__).parent
UPLOAD_DIR = BASE_DIR / "uploads"
DB_PATH    = BASE_DIR / "db" / "review.db"
LOG_FILE   = BASE_DIR / "db" / "activity.log"

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff"}
MAX_FILE_SIZE_MB   = 20

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024  # 200 MB

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger(__name__)


def log_activity(action: str, detail: str = ""):
    logger.info(f"{action} | {detail}")


# ── Database ──────────────────────────────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS images (
            id          TEXT PRIMARY KEY,
            filename    TEXT NOT NULL,
            filepath    TEXT NOT NULL,
            source_url  TEXT,
            file_type   TEXT,
            file_size   INTEGER,
            width       INTEGER,
            height      INTEGER,
            file_hash   TEXT,
            phash       TEXT,
            status      TEXT DEFAULT 'needs_review',
            notes       TEXT DEFAULT '',
            tags        TEXT DEFAULT '',
            imported_at TEXT,
            updated_at  TEXT
        );
        CREATE TABLE IF NOT EXISTS logs (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            action     TEXT,
            detail     TEXT,
            created_at TEXT
        );
        """)
    logger.info("Database initialized")


init_db()


# ── Helpers ───────────────────────────────────────────────────────────────────
def file_hash(filepath: Path) -> str:
    h = hashlib.md5()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def perceptual_hash(filepath: Path) -> str | None:
    try:
        with Image.open(filepath) as img:
            return str(imagehash.phash(img))
    except Exception:
        return None


def get_image_meta(filepath: Path) -> dict:
    meta = {"width": None, "height": None, "file_size": filepath.stat().st_size}
    try:
        with Image.open(filepath) as img:
            meta["width"], meta["height"] = img.size
    except Exception:
        pass
    return meta


def save_image_record(filepath: Path, source_url: str = "") -> dict:
    img_id   = str(uuid.uuid4())
    fhash    = file_hash(filepath)
    phash    = perceptual_hash(filepath)
    meta     = get_image_meta(filepath)
    now      = datetime.utcnow().isoformat()
    ext      = filepath.suffix.lower()
    file_type = mimetypes.types_map.get(ext, f"image/{ext.lstrip('.')}")

    # Exact-duplicate check
    with get_db() as conn:
        existing = conn.execute(
            "SELECT id, filename FROM images WHERE file_hash = ?", (fhash,)
        ).fetchone()
        if existing:
            return {
                "duplicate": True,
                "original_id": existing["id"],
                "original_filename": existing["filename"],
                "filename": filepath.name,
            }

        conn.execute(
            """INSERT INTO images
               (id, filename, filepath, source_url, file_type, file_size,
                width, height, file_hash, phash, status, imported_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,'needs_review',?,?)""",
            (img_id, filepath.name, str(filepath), source_url, file_type,
             meta["file_size"], meta["width"], meta["height"],
             fhash, phash, now, now),
        )
        db_log(conn, "IMPORT", f"Saved {filepath.name} | size={meta['file_size']} | hash={fhash[:8]}...")

    return {"duplicate": False, "id": img_id, "filename": filepath.name}


def db_log(conn, action: str, detail: str):
    conn.execute(
        "INSERT INTO logs (action, detail, created_at) VALUES (?,?,?)",
        (action, detail, datetime.utcnow().isoformat()),
    )


# ── Routes ────────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/images")
def list_images():
    status = request.args.get("status", "")
    search = request.args.get("search", "")
    with get_db() as conn:
        query = "SELECT * FROM images WHERE 1=1"
        params = []
        if status:
            query += " AND status = ?"
            params.append(status)
        if search:
            query += " AND (filename LIKE ? OR tags LIKE ? OR notes LIKE ?)"
            params += [f"%{search}%", f"%{search}%", f"%{search}%"]
        query += " ORDER BY imported_at DESC"
        rows = conn.execute(query, params).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/images/<img_id>", methods=["PATCH"])
def update_image(img_id):
    data = request.json or {}
    allowed = {"status", "notes", "tags"}
    updates = {k: v for k, v in data.items() if k in allowed}
    if not updates:
        return jsonify({"error": "Nothing to update"}), 400

    updates["updated_at"] = datetime.utcnow().isoformat()
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [img_id]

    with get_db() as conn:
        conn.execute(f"UPDATE images SET {set_clause} WHERE id = ?", values)
        db_log(conn, "UPDATE", f"id={img_id} | changes={list(updates.keys())}")

    log_activity("UPDATE", f"Image {img_id} updated: {updates}")
    return jsonify({"ok": True})


@app.route("/api/images/<img_id>", methods=["DELETE"])
def delete_image(img_id):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM images WHERE id = ?", (img_id,)).fetchone()
        if not row:
            return jsonify({"error": "Not found"}), 404
        filepath = Path(row["filepath"])
        if filepath.exists():
            filepath.unlink()
        conn.execute("DELETE FROM images WHERE id = ?", (img_id,))
        db_log(conn, "DELETE", f"Deleted {row['filename']}")
    log_activity("DELETE", f"Removed image {img_id}")
    return jsonify({"ok": True})


@app.route("/api/batch", methods=["POST"])
def batch_action():
    data = request.json or {}
    ids    = data.get("ids", [])
    action = data.get("action", "")
    if not ids or action not in ("keep", "reject", "needs_review", "delete"):
        return jsonify({"error": "Invalid batch action"}), 400

    with get_db() as conn:
        if action == "delete":
            for img_id in ids:
                row = conn.execute("SELECT * FROM images WHERE id = ?", (img_id,)).fetchone()
                if row:
                    filepath = Path(row["filepath"])
                    if filepath.exists():
                        filepath.unlink()
                    conn.execute("DELETE FROM images WHERE id = ?", (img_id,))
        else:
            conn.execute(
                f"UPDATE images SET status = ?, updated_at = ? WHERE id IN ({','.join('?'*len(ids))})",
                [action, datetime.utcnow().isoformat()] + ids,
            )
        db_log(conn, "BATCH", f"action={action} | count={len(ids)}")

    log_activity("BATCH", f"{action} applied to {len(ids)} images")
    return jsonify({"ok": True, "affected": len(ids)})


@app.route("/api/import/files", methods=["POST"])
def import_files():
    files = request.files.getlist("images")
    if not files:
        return jsonify({"error": "No files provided"}), 400

    results = []
    for f in files:
        ext = Path(f.filename).suffix.lower()
        if ext not in ALLOWED_EXTENSIONS:
            results.append({"filename": f.filename, "error": "Unsupported type"})
            continue
        dest = UPLOAD_DIR / f"{uuid.uuid4().hex}{ext}"
        f.save(dest)
        r = save_image_record(dest)
        results.append(r)

    log_activity("IMPORT_FILES", f"{len(files)} files received")
    return jsonify(results)


@app.route("/api/import/zip", methods=["POST"])
def import_zip():
    zf = request.files.get("zipfile")
    if not zf:
        return jsonify({"error": "No zip file"}), 400

    results = []
    try:
        with zipfile.ZipFile(io.BytesIO(zf.read())) as z:
            for name in z.namelist():
                ext = Path(name).suffix.lower()
                if ext not in ALLOWED_EXTENSIONS:
                    continue
                data = z.read(name)
                dest = UPLOAD_DIR / f"{uuid.uuid4().hex}{ext}"
                dest.write_bytes(data)
                r = save_image_record(dest)
                results.append(r)
    except zipfile.BadZipFile:
        return jsonify({"error": "Invalid ZIP file"}), 400

    log_activity("IMPORT_ZIP", f"Extracted {len(results)} images from zip")
    return jsonify(results)


@app.route("/api/import/urls", methods=["POST"])
def import_urls():
    data = request.json or {}
    urls = data.get("urls", [])
    if not urls:
        return jsonify({"error": "No URLs provided"}), 400

    results = []
    headers = {"User-Agent": "Mozilla/5.0 (compatible; ImageReviewBot/1.0)"}

    for url in urls[:50]:  # cap at 50
        try:
            r = requests.get(url.strip(), timeout=10, headers=headers, stream=True)
            r.raise_for_status()
            ct = r.headers.get("content-type", "")
            if "image" not in ct:
                results.append({"url": url, "error": "Not an image"})
                continue
            ext = "." + ct.split("/")[-1].split(";")[0].strip()
            if ext not in ALLOWED_EXTENSIONS:
                ext = ".jpg"
            dest = UPLOAD_DIR / f"{uuid.uuid4().hex}{ext}"
            dest.write_bytes(r.content)
            rec = save_image_record(dest, source_url=url)
            results.append(rec)
        except Exception as e:
            results.append({"url": url, "error": str(e)})

    log_activity("IMPORT_URLS", f"Fetched {len(urls)} URLs → {len(results)} processed")
    return jsonify(results)


@app.route("/api/import/scrape", methods=["POST"])
def scrape_page():
    data = request.json or {}
    page_url = data.get("url", "").strip()
    if not page_url:
        return jsonify({"error": "No URL provided"}), 400

    try:
        headers = {"User-Agent": "Mozilla/5.0 (compatible; ImageReviewBot/1.0)"}
        r = requests.get(page_url, timeout=15, headers=headers)
        r.raise_for_status()
    except Exception as e:
        return jsonify({"error": f"Failed to fetch page: {e}"}), 400

    soup = BeautifulSoup(r.text, "html.parser")
    img_urls = []
    for tag in soup.find_all("img"):
        src = tag.get("src") or tag.get("data-src") or ""
        if src:
            img_urls.append(urljoin(page_url, src))

    # Remove duplicates preserving order
    seen = set()
    img_urls = [u for u in img_urls if not (u in seen or seen.add(u))]

    log_activity("SCRAPE", f"Found {len(img_urls)} images on {page_url}")
    return jsonify({"urls": img_urls[:100], "page": page_url, "count": len(img_urls)})


@app.route("/api/import/csv", methods=["POST"])
def import_csv():
    csvfile = request.files.get("csvfile")
    if not csvfile:
        return jsonify({"error": "No CSV file"}), 400

    content = csvfile.read().decode("utf-8", errors="replace")
    reader  = csv.DictReader(io.StringIO(content))
    urls    = []
    for row in reader:
        for col in ("url", "image_url", "src", "link", "image"):
            val = row.get(col, "").strip()
            if val and val.startswith("http"):
                urls.append(val)
                break

    log_activity("IMPORT_CSV", f"Parsed {len(urls)} URLs from CSV")
    return jsonify({"urls": urls})


@app.route("/api/duplicates")
def find_duplicates():
    """Return groups of near-duplicate images using perceptual hashing."""
    with get_db() as conn:
        rows = conn.execute("SELECT id, filename, phash FROM images WHERE phash IS NOT NULL").fetchall()

    groups = []
    used   = set()

    items = [(r["id"], r["filename"], imagehash.hex_to_hash(r["phash"])) for r in rows]

    for i, (id_a, fn_a, h_a) in enumerate(items):
        if id_a in used:
            continue
        group = [{"id": id_a, "filename": fn_a}]
        for id_b, fn_b, h_b in items[i + 1:]:
            if id_b in used:
                continue
            if h_a - h_b <= 10:  # perceptual distance threshold
                group.append({"id": id_b, "filename": fn_b})
                used.add(id_b)
        if len(group) > 1:
            used.add(id_a)
            groups.append(group)

    return jsonify(groups)


@app.route("/api/stats")
def stats():
    with get_db() as conn:
        total  = conn.execute("SELECT COUNT(*) FROM images").fetchone()[0]
        keep   = conn.execute("SELECT COUNT(*) FROM images WHERE status='keep'").fetchone()[0]
        reject = conn.execute("SELECT COUNT(*) FROM images WHERE status='reject'").fetchone()[0]
        review = conn.execute("SELECT COUNT(*) FROM images WHERE status='needs_review'").fetchone()[0]
        size   = conn.execute("SELECT SUM(file_size) FROM images").fetchone()[0] or 0
    return jsonify({
        "total": total, "keep": keep,
        "reject": reject, "needs_review": review,
        "total_size_mb": round(size / (1024 * 1024), 2),
    })


@app.route("/api/export/csv")
def export_csv():
    status = request.args.get("status", "")
    with get_db() as conn:
        query = "SELECT * FROM images"
        params = []
        if status:
            query += " WHERE status = ?"
            params.append(status)
        rows = conn.execute(query, params).fetchall()
        db_log(conn, "EXPORT", f"CSV export | status={status or 'all'} | count={len(rows)}")

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id","filename","source_url","file_type","file_size","width","height",
                     "file_hash","status","notes","tags","imported_at","updated_at"])
    for r in rows:
        writer.writerow([r["id"],r["filename"],r["source_url"],r["file_type"],r["file_size"],
                         r["width"],r["height"],r["file_hash"],r["status"],r["notes"],
                         r["tags"],r["imported_at"],r["updated_at"]])

    log_activity("EXPORT", f"Exported {len(rows)} records as CSV")
    buf.seek(0)
    return send_file(
        io.BytesIO(buf.getvalue().encode()),
        mimetype="text/csv",
        as_attachment=True,
        download_name=f"image_review_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
    )


@app.route("/api/export/json")
def export_json():
    status = request.args.get("status", "")
    with get_db() as conn:
        query = "SELECT * FROM images"
        params = []
        if status:
            query += " WHERE status = ?"
            params.append(status)
        rows = conn.execute(query, params).fetchall()
        db_log(conn, "EXPORT", f"JSON export | status={status or 'all'} | count={len(rows)}")

    data = [dict(r) for r in rows]
    log_activity("EXPORT", f"Exported {len(data)} records as JSON")
    return send_file(
        io.BytesIO(json.dumps(data, indent=2).encode()),
        mimetype="application/json",
        as_attachment=True,
        download_name=f"image_review_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json",
    )


@app.route("/api/export/zip")
def export_zip():
    """Export only 'keep' images as a zip."""
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM images WHERE status='keep'").fetchall()

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for r in rows:
            p = Path(r["filepath"])
            if p.exists():
                zf.write(p, r["filename"])
    buf.seek(0)

    log_activity("EXPORT_ZIP", f"Zipped {len(rows)} 'keep' images")
    return send_file(
        buf, mimetype="application/zip", as_attachment=True,
        download_name=f"keep_images_{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip",
    )


@app.route("/api/logs")
def get_logs():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM logs ORDER BY id DESC LIMIT 100").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/uploads/<filename>")
def serve_upload(filename):
    return send_from_directory(UPLOAD_DIR, filename)


if __name__ == "__main__":
    print("\n🚀  Image Dataset Cleaner & Review Tool")
    print("   → http://127.0.0.1:5000\n")
    app.run(debug=True, port=5000)
