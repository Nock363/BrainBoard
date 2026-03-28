from __future__ import annotations

import json
import shutil
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


class BrainSessionStore:
    def __init__(self, data_dir: Path, db_path: Path, settings_path: Path, media_dir: Path) -> None:
        self.data_dir = data_dir
        self.db_path = db_path
        self.settings_path = settings_path
        self.media_dir = media_dir
        self._lock = threading.RLock()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.media_dir.mkdir(parents=True, exist_ok=True)
        self._init_db()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def _init_db(self) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS notes (
                    id TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )

    def list_notes(self) -> list[dict[str, Any]]:
        with self._lock, self._connect() as conn:
            rows = conn.execute("SELECT payload FROM notes ORDER BY updated_at DESC, created_at DESC").fetchall()
        notes: list[dict[str, Any]] = []
        for row in rows:
            notes.append(json.loads(row["payload"]))
        return notes

    def get_note(self, note_id: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT payload FROM notes WHERE id = ?", (note_id,)).fetchone()
        if row is None:
            return None
        return json.loads(row["payload"])

    def save_note(self, note: dict[str, Any]) -> dict[str, Any]:
        payload = json.dumps(note, ensure_ascii=False, indent=2)
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO notes (id, payload, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    payload = excluded.payload,
                    updated_at = excluded.updated_at
                """,
                (note["id"], payload, note["createdAt"], note["updatedAt"]),
            )
        return note

    def delete_note(self, note_id: str) -> None:
        with self._lock, self._connect() as conn:
            conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))
        shutil.rmtree(self.note_media_dir(note_id), ignore_errors=True)

    def delete_all_notes(self) -> None:
        with self._lock, self._connect() as conn:
            conn.execute("DELETE FROM notes")
        shutil.rmtree(self.media_dir, ignore_errors=True)
        self.media_dir.mkdir(parents=True, exist_ok=True)

    def load_settings(self) -> dict[str, Any]:
        if not self.settings_path.exists():
            return {}
        try:
            return json.loads(self.settings_path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def save_settings(self, settings: dict[str, Any]) -> dict[str, Any]:
        self.settings_path.parent.mkdir(parents=True, exist_ok=True)
        self.settings_path.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return settings

    def note_media_dir(self, note_id: str) -> Path:
        return self.media_dir / "notes" / note_id

    def write_audio_file(self, note_id: str, entry_id: str, blob: bytes, suffix: str) -> str:
        clean_suffix = suffix if suffix.startswith(".") else f".{suffix}"
        target_dir = self.note_media_dir(note_id)
        target_dir.mkdir(parents=True, exist_ok=True)
        file_path = target_dir / f"{entry_id}{clean_suffix}"
        file_path.write_bytes(blob)
        return str(file_path.relative_to(self.media_dir)).replace("\\", "/")

