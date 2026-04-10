from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def _path_from_env(name: str, fallback: Path) -> Path:
    raw = os.getenv(name, "").strip()
    if not raw:
        return fallback
    return Path(raw).expanduser().resolve()


@dataclass(frozen=True)
class AppConfig:
    base_dir: Path
    data_dir: Path
    media_dir: Path
    db_path: Path
    settings_path: Path
    frontend_dist_dir: Path
    openai_api_key: str
    transcription_model: str
    summary_model: str
    follow_up_model: str
    language: str
    port: int


def get_config() -> AppConfig:
    base_dir = Path(__file__).resolve().parents[1]
    data_dir = _path_from_env("BRAINSESSION_DATA_DIR", base_dir / "data")
    media_dir = _path_from_env("BRAINSESSION_MEDIA_DIR", data_dir / "media")
    frontend_dist_dir = _path_from_env("BRAINSESSION_FRONTEND_DIST_DIR", base_dir / "frontend" / "dist")
    return AppConfig(
        base_dir=base_dir,
        data_dir=data_dir,
        media_dir=media_dir,
        db_path=data_dir / "brainsession.sqlite3",
        settings_path=data_dir / "settings.json",
        frontend_dist_dir=frontend_dist_dir,
        openai_api_key=os.getenv("OPENAI_API_KEY", "").strip(),
        transcription_model=os.getenv("BRAINSESSION_TRANSCRIPTION_MODEL", "gpt-4o-transcribe").strip() or "gpt-4o-transcribe",
        summary_model=os.getenv("BRAINSESSION_SUMMARY_MODEL", "gpt-4o-mini").strip() or "gpt-4o-mini",
        follow_up_model=os.getenv("BRAINSESSION_FOLLOW_UP_MODEL", "gpt-4o-mini").strip() or "gpt-4o-mini",
        language=os.getenv("BRAINSESSION_LANGUAGE", "de").strip() or "de",
        port=int(os.getenv("PORT", "8000")),
    )
