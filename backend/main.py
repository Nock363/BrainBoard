from __future__ import annotations

import json
import mimetypes
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from backend.ai import (
    classify_note_category,
    interpret_text_note,
    set_llm_logger,
    summarize_note_timeline,
    transcribe_audio,
    DEFAULT_CATEGORY_PROMPT_PREFIX,
)
from backend.config import get_config
from backend.models import (
    AppendTextRequest,
    CreateTextNoteRequest,
    NoteNode,
    NoteResponse,
    NotesResponse,
    NoteTimelineEntry,
    LlmLogsResponse,
    ReportResponse,
    RoutineResponse,
    SettingsResponse,
    UpdateNoteCategoryRequest,
    UpdateSettingsRequest,
)
from backend.storage import BrainSessionStore


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def make_note_id() -> str:
    return f"note_{uuid4().hex[:12]}"


def make_entry_id() -> str:
    return f"entry_{uuid4().hex[:12]}"


def clean_text_value(value: object) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if text.lower() in {"none", "null"}:
        return ""
    return text


def resolve_note_category(note: dict[str, object]) -> str:
    if "manualCategory" in note:
        return validate_note_category(clean_text_value(note.get("manualCategory")))

    category = clean_text_value(note.get("category"))
    if category in {"Idea", "Task"}:
        return category
    return ""


def validate_note_category(category: str) -> str:
    if category in {"", "Idea", "Task"}:
        return category
    raise ValueError("Ungültige Klasse")


def file_extension_for_upload(upload: UploadFile) -> str:
    filename_ext = Path(upload.filename or "").suffix.lower().strip()
    if filename_ext in {".webm", ".mp4", ".m4a", ".wav", ".mp3", ".ogg"}:
        return filename_ext
    guessed = mimetypes.guess_extension(upload.content_type or "")
    if guessed in {".webm", ".mp4", ".m4a", ".wav", ".mp3", ".ogg"}:
        return guessed
    if upload.content_type == "audio/mp4":
        return ".m4a"
    return ".webm"


def note_to_model(note: dict[str, object], media_url_fn) -> NoteNode:
    entries = [
        NoteTimelineEntry(
            id=str(entry.get("id", "")),
            kind=str(entry.get("kind", "text")),
            transcript=str(entry.get("transcript", "")),
            audioRelativePath=str(entry.get("audioRelativePath", "")),
            transcriptionState=str(entry.get("transcriptionState", "")),
            transcriptionError=str(entry.get("transcriptionError", "")),
            createdAt=str(entry.get("createdAt", "")),
            updatedAt=str(entry.get("updatedAt", "")),
        )
        for entry in note.get("entries", [])
        if isinstance(entry, dict)
    ]
    return NoteNode(
        id=str(note.get("id", "")),
        title=clean_text_value(note.get("title")),
        summaryHeadline=clean_text_value(note.get("summaryHeadline")) or clean_text_value(note.get("title")),
        summary=clean_text_value(note.get("summary")),
        rawTranscript=clean_text_value(note.get("rawTranscript")),
        category=resolve_note_category(note),
        audioRelativePath=clean_text_value(note.get("audioRelativePath")),
        entries=entries,
        createdAt=clean_text_value(note.get("createdAt")),
        updatedAt=clean_text_value(note.get("updatedAt")),
    )


def model_to_dict(model: NoteNode) -> dict[str, object]:
    return json.loads(model.model_dump_json())


def default_settings(config) -> dict[str, object]:
    return {
        "openAiApiKey": config.openai_api_key,
        "openAiModel": config.summary_model,
        "transcriptionModel": config.transcription_model,
        "summaryModel": config.summary_model,
        "followUpModel": config.follow_up_model,
        "language": config.language,
        "categoryPromptPrefix": DEFAULT_CATEGORY_PROMPT_PREFIX,
    }


def category_prompt_prefix_from(settings: dict[str, object]) -> str:
    return clean_text_value(settings.get("categoryPromptPrefix")) or DEFAULT_CATEGORY_PROMPT_PREFIX


def build_note_from_text(
    text: str,
    *,
    api_key: str,
    summary_model: str,
    category_prompt_prefix: str,
    create_entry_kind: str = "text",
    audio_relative_path: str = "",
    transcription_state: str = "done",
    transcription_error: str = "",
) -> dict[str, object]:
    summary_result = interpret_text_note(api_key, summary_model, text)
    note_id = make_note_id()
    entry_id = make_entry_id()
    now = utc_now()
    entry = {
        "id": entry_id,
        "kind": create_entry_kind,
        "transcript": text.strip(),
        "audioRelativePath": audio_relative_path,
        "transcriptionState": transcription_state,
        "transcriptionError": transcription_error,
        "createdAt": now,
        "updatedAt": now,
    }
    headline = clean_text_value(summary_result.get("summaryHeadline")) or clean_text_value(summary_result.get("title")) or "Neue Notiz"
    summary_text = clean_text_value(summary_result.get("summary")) or text.strip()
    category = classify_note_category(api_key, summary_model, category_prompt_prefix, summary_text)
    return {
        "id": note_id,
        "title": headline,
        "summaryHeadline": headline,
        "summary": summary_text,
        "rawTranscript": text.strip(),
        "category": category,
        "audioRelativePath": audio_relative_path,
        "entries": [entry],
        "createdAt": now,
        "updatedAt": now,
    }


def reanalyze_note(
    note: dict[str, object],
    *,
    api_key: str,
    summary_model: str,
    category_prompt_prefix: str,
) -> dict[str, object]:
    transcripts = [str(item.get("transcript", "")).strip() for item in note.get("entries", []) if isinstance(item, dict) and str(item.get("transcript", "")).strip()]
    if not transcripts:
        raise ValueError("Keine Eintraege fuer diese Notiz vorhanden")
    note = recompute_summary(
        note,
        api_key=api_key,
        summary_model=summary_model,
        category_prompt_prefix=category_prompt_prefix,
    )
    return note


def recompute_summary(
    note: dict[str, object],
    *,
    api_key: str,
    summary_model: str,
    category_prompt_prefix: str,
) -> dict[str, object]:
    entries = [str(entry.get("transcript", "")).strip() for entry in note.get("entries", []) if isinstance(entry, dict)]
    entries = [item for item in entries if item]
    if not entries:
        return note
    summary_result = summarize_note_timeline(
        api_key=api_key,
        model=summary_model,
        note_title=clean_text_value(note.get("title")),
        entry_transcripts=entries,
    )
    summary_headline = clean_text_value(summary_result.get("summaryHeadline")) or clean_text_value(note.get("title")) or "Neue Notiz"
    note["summary"] = clean_text_value(summary_result.get("summary")) or clean_text_value(note.get("summary"))
    note["title"] = summary_headline
    note["summaryHeadline"] = summary_headline
    note["category"] = classify_note_category(api_key, summary_model, category_prompt_prefix, note["summary"])
    note["rawTranscript"] = "\n".join(entries)
    return note


config = get_config()
store = BrainSessionStore(config.data_dir, config.db_path, config.settings_path, config.media_dir)
set_llm_logger(store.save_llm_log)

app = FastAPI(title="BrainSession PWA", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, object]:
    return {
        "ok": True,
        "time": utc_now(),
        "notes": len(store.list_notes()),
    }


@app.get("/api/settings", response_model=SettingsResponse)
def get_settings() -> SettingsResponse:
    current = {**default_settings(config), **store.load_settings()}
    return SettingsResponse(
        openAiApiKeyPresent=bool(current.get("openAiApiKey")),
        openAiModel=str(current.get("openAiModel", config.summary_model)),
        transcriptionModel=str(current.get("transcriptionModel", config.transcription_model)),
        summaryModel=str(current.get("summaryModel", config.summary_model)),
        followUpModel=str(current.get("followUpModel", config.follow_up_model)),
        language=str(current.get("language", config.language)),
        categoryPromptPrefix=category_prompt_prefix_from(current),
        dataDir=str(config.data_dir),
        mediaDir=str(config.media_dir),
    )


@app.put("/api/settings", response_model=SettingsResponse)
def update_settings(payload: UpdateSettingsRequest) -> SettingsResponse:
    current = {**default_settings(config), **store.load_settings()}
    if payload.openAiApiKey is not None and payload.openAiApiKey.strip():
        current["openAiApiKey"] = payload.openAiApiKey.strip()
    if payload.openAiModel is not None and payload.openAiModel.strip():
        current["openAiModel"] = payload.openAiModel.strip()
        current["summaryModel"] = payload.openAiModel.strip()
    if payload.summaryModel is not None and payload.summaryModel.strip():
        current["summaryModel"] = payload.summaryModel.strip()
    if payload.transcriptionModel is not None and payload.transcriptionModel.strip():
        current["transcriptionModel"] = payload.transcriptionModel.strip()
    if payload.followUpModel is not None and payload.followUpModel.strip():
        current["followUpModel"] = payload.followUpModel.strip()
    if payload.language is not None and payload.language.strip():
        current["language"] = payload.language.strip()
    if payload.categoryPromptPrefix is not None:
        current["categoryPromptPrefix"] = payload.categoryPromptPrefix.strip() or DEFAULT_CATEGORY_PROMPT_PREFIX
    store.save_settings(current)
    return get_settings()


@app.get("/api/notes", response_model=NotesResponse)
def list_notes() -> NotesResponse:
    return NotesResponse(notes=[note_to_model(note, lambda rel: f"/media/{rel}") for note in store.list_notes()])


@app.get("/api/llm-logs", response_model=LlmLogsResponse)
def list_llm_logs(limit: int = 100) -> LlmLogsResponse:
    return LlmLogsResponse(logs=store.list_llm_logs(limit))


@app.get("/api/notes/{note_id}", response_model=NoteResponse)
def get_note(note_id: str) -> NoteResponse:
    note = store.get_note(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note nicht gefunden")
    return NoteResponse(note=note_to_model(note, lambda rel: f"/media/{rel}"))


@app.post("/api/notes/text", response_model=NoteResponse)
def create_text_note(payload: CreateTextNoteRequest) -> NoteResponse:
    settings = get_settings()
    current_settings = store.load_settings()
    api_key = str(current_settings.get("openAiApiKey") or config.openai_api_key)
    note = build_note_from_text(
        payload.text,
        api_key=api_key,
        summary_model=str(current_settings.get("summaryModel") or settings.summaryModel),
        category_prompt_prefix=category_prompt_prefix_from(current_settings),
    )
    store.save_note(note)
    return NoteResponse(note=note_to_model(note, lambda rel: f"/media/{rel}"))


@app.post("/api/notes/voice", response_model=NoteResponse)
async def create_voice_note(
    audio: UploadFile = File(...),
    noteId: str | None = Form(default=None),
) -> NoteResponse:
    current_settings = {**default_settings(config), **store.load_settings()}
    api_key = str(current_settings.get("openAiApiKey") or "")
    summary_model = str(current_settings.get("summaryModel") or config.summary_model)
    transcription_model = str(current_settings.get("transcriptionModel") or config.transcription_model)
    language = str(current_settings.get("language") or config.language)
    ext = file_extension_for_upload(audio)
    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Audio Datei ist leer")

    note = store.get_note(noteId) if noteId else None
    new_note = note is None
    if note is None:
        note = {
            "id": make_note_id(),
            "title": "Neue Notiz",
            "summaryHeadline": "Neue Notiz",
            "summary": "",
            "rawTranscript": "",
            "category": "",
            "audioRelativePath": "",
            "entries": [],
            "createdAt": utc_now(),
            "updatedAt": utc_now(),
        }
    now = utc_now()
    entry_id = make_entry_id()
    relative_path = store.write_audio_file(str(note["id"]), entry_id, audio_bytes, ext)
    entry = {
        "id": entry_id,
        "kind": "voice",
        "transcript": "",
        "audioRelativePath": relative_path,
        "transcriptionState": "processing",
        "transcriptionError": "",
        "createdAt": now,
        "updatedAt": now,
    }
    note["entries"] = list(note.get("entries", [])) + [entry]
    if not note.get("audioRelativePath"):
        note["audioRelativePath"] = relative_path
    note["updatedAt"] = now
    store.save_note(note)

    try:
        transcript = transcribe_audio(
            api_key=api_key,
            audio_path=store.media_dir / relative_path,
            model=transcription_model,
            language=language,
            prompt="Das hier ist eine deutsche Sprachmemo. Transkribiere nur klar hörbare Worte. Erfinde nichts.",
        )
        entry["transcript"] = transcript
        entry["transcriptionState"] = "done"
        entry["updatedAt"] = utc_now()
        if new_note:
            note_result = build_note_from_text(
                transcript,
                api_key=api_key,
                summary_model=summary_model,
                category_prompt_prefix=category_prompt_prefix_from(current_settings),
                create_entry_kind="voice",
                audio_relative_path=relative_path,
            )
            note_result["id"] = str(note["id"])
            note_result["entries"] = [entry]
            note_result["audioRelativePath"] = relative_path
            note_result["createdAt"] = note["createdAt"]
            note_result["updatedAt"] = utc_now()
            note = note_result
        else:
            summary_result = interpret_text_note(api_key, summary_model, transcript)
            if not clean_text_value(note.get("title")):
                note["title"] = clean_text_value(summary_result.get("summaryHeadline")) or note.get("title", "Neue Notiz")
            if not note.get("summary"):
                note["summary"] = clean_text_value(summary_result.get("summary")) or transcript.strip()
            note = recompute_summary(
                note,
                api_key=api_key,
                summary_model=summary_model,
            )
    except Exception as error:
        entry["transcriptionState"] = "pending_retry"
        entry["transcriptionError"] = str(error)
        entry["updatedAt"] = utc_now()
        if new_note:
            note["title"] = "Neue Notiz"
            note["summary"] = "Die Aufnahme ist gespeichert und kann später erneut transkribiert werden."
        note["updatedAt"] = utc_now()
    note["entries"] = list(note.get("entries", []))
    note["entries"][-1] = entry
    note["updatedAt"] = utc_now()
    if not note.get("rawTranscript") and entry.get("transcript"):
        note["rawTranscript"] = str(entry["transcript"]).strip()
    if entry.get("transcript") and note.get("entries"):
        transcripts = [str(item.get("transcript", "")).strip() for item in note["entries"] if isinstance(item, dict) and str(item.get("transcript", "")).strip()]
        note["rawTranscript"] = "\n".join(transcripts)
    store.save_note(note)
    return NoteResponse(note=note_to_model(note, lambda rel: f"/media/{rel}"))


@app.post("/api/notes/{note_id}/entries/text", response_model=NoteResponse)
def append_text_to_note(note_id: str, payload: AppendTextRequest) -> NoteResponse:
    current_settings = {**default_settings(config), **store.load_settings()}
    api_key = str(current_settings.get("openAiApiKey") or "")
    summary_model = str(current_settings.get("summaryModel") or config.summary_model)
    note = store.get_note(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note nicht gefunden")
    now = utc_now()
    entry = {
        "id": make_entry_id(),
        "kind": "text",
        "transcript": payload.text.strip(),
        "audioRelativePath": "",
        "transcriptionState": "done",
        "transcriptionError": "",
        "createdAt": now,
        "updatedAt": now,
    }
    note["entries"] = list(note.get("entries", [])) + [entry]
    transcripts = [str(item.get("transcript", "")).strip() for item in note["entries"] if isinstance(item, dict) and str(item.get("transcript", "")).strip()]
    note["rawTranscript"] = "\n".join(transcripts)
    note["updatedAt"] = now
    if api_key:
        try:
            note = reanalyze_note(
                note,
                api_key=api_key,
                summary_model=summary_model,
                category_prompt_prefix=category_prompt_prefix_from(current_settings),
            )
        except Exception:
            pass
    else:
        try:
            note = reanalyze_note(
                note,
                api_key="",
                summary_model=summary_model,
                category_prompt_prefix=category_prompt_prefix_from(current_settings),
            )
        except Exception:
            summary_result = interpret_text_note("", summary_model, "\n".join(transcripts))
            note["summaryHeadline"] = summary_result["summaryHeadline"]
            note["summary"] = summary_result["summary"]
            note["title"] = summary_result["summaryHeadline"]
            note["category"] = classify_note_category("", summary_model, category_prompt_prefix_from(current_settings), summary_result["summary"])
    note["updatedAt"] = utc_now()
    store.save_note(note)
    return NoteResponse(note=note_to_model(note, lambda rel: f"/media/{rel}"))


@app.post("/api/notes/{note_id}/regenerate-summary", response_model=NoteResponse)
def regenerate_summary(note_id: str) -> NoteResponse:
    current_settings = {**default_settings(config), **store.load_settings()}
    api_key = str(current_settings.get("openAiApiKey") or "")
    summary_model = str(current_settings.get("summaryModel") or config.summary_model)
    note = store.get_note(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note nicht gefunden")
    transcripts = [str(item.get("transcript", "")).strip() for item in note.get("entries", []) if isinstance(item, dict) and str(item.get("transcript", "")).strip()]
    if not transcripts:
        raise HTTPException(status_code=400, detail="Keine Eintraege fuer diese Notiz vorhanden")
    note = reanalyze_note(
        note,
        api_key=api_key,
        summary_model=summary_model,
        category_prompt_prefix=category_prompt_prefix_from(current_settings),
    )
    note["updatedAt"] = utc_now()
    store.save_note(note)
    return NoteResponse(note=note_to_model(note, lambda rel: f"/media/{rel}"))


@app.post("/api/notes/{note_id}/analyze", response_model=NoteResponse)
def analyze_note(note_id: str) -> NoteResponse:
    return regenerate_summary(note_id)


@app.put("/api/notes/{note_id}/category", response_model=NoteResponse)
def update_note_category(note_id: str, payload: UpdateNoteCategoryRequest) -> NoteResponse:
    note = store.get_note(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note nicht gefunden")
    try:
        validated_category = validate_note_category(payload.category)
        note["category"] = validated_category
        note["manualCategory"] = validated_category
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    note["updatedAt"] = utc_now()
    store.save_note(note)
    return NoteResponse(note=note_to_model(note, lambda rel: f"/media/{rel}"))


@app.post("/api/routines/reanalyze-notes", response_model=RoutineResponse)
def reanalyze_all_notes() -> RoutineResponse:
    current_settings = {**default_settings(config), **store.load_settings()}
    api_key = str(current_settings.get("openAiApiKey") or "")
    summary_model = str(current_settings.get("summaryModel") or config.summary_model)
    updated_notes = 0
    skipped_notes = 0
    for note in store.list_notes():
        transcripts = [str(item.get("transcript", "")).strip() for item in note.get("entries", []) if isinstance(item, dict) and str(item.get("transcript", "")).strip()]
        if not transcripts:
            skipped_notes += 1
            continue
        try:
            note.pop("manualCategory", None)
            note = reanalyze_note(
                note,
                api_key=api_key,
                summary_model=summary_model,
                category_prompt_prefix=category_prompt_prefix_from(current_settings),
            )
            note["updatedAt"] = utc_now()
            store.save_note(note)
            updated_notes += 1
        except Exception:
            skipped_notes += 1
    return RoutineResponse(ok=True, updatedNotes=updated_notes, skippedNotes=skipped_notes)


@app.post("/api/notes/{note_id}/entries/{entry_id}/retry", response_model=NoteResponse)
def retry_transcription(note_id: str, entry_id: str) -> NoteResponse:
    current_settings = {**default_settings(config), **store.load_settings()}
    api_key = str(current_settings.get("openAiApiKey") or "")
    summary_model = str(current_settings.get("summaryModel") or config.summary_model)
    transcription_model = str(current_settings.get("transcriptionModel") or config.transcription_model)
    language = str(current_settings.get("language") or config.language)
    if not api_key:
        raise HTTPException(status_code=400, detail="OpenAI API key fehlt")
    note = store.get_note(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note nicht gefunden")
    entry = next((item for item in note.get("entries", []) if isinstance(item, dict) and item.get("id") == entry_id), None)
    if entry is None:
        raise HTTPException(status_code=404, detail="Eintrag nicht gefunden")
    audio_rel = str(entry.get("audioRelativePath", ""))
    if not audio_rel:
        raise HTTPException(status_code=400, detail="Kein Audio fuer diesen Eintrag vorhanden")
    transcript = transcribe_audio(
        api_key=api_key,
        audio_path=store.media_dir / audio_rel,
        model=transcription_model,
        language=language,
        prompt="Das hier ist eine deutsche Sprachmemo. Transkribiere nur klar hörbare Worte. Erfinde nichts.",
    )
    entry["transcript"] = transcript
    entry["transcriptionState"] = "done"
    entry["transcriptionError"] = ""
    entry["updatedAt"] = utc_now()
    transcripts = [str(item.get("transcript", "")).strip() for item in note.get("entries", []) if isinstance(item, dict) and str(item.get("transcript", "")).strip()]
    note["rawTranscript"] = "\n".join(transcripts)
    note["updatedAt"] = utc_now()
    note = recompute_summary(
        note,
        api_key=api_key,
        summary_model=summary_model,
    )
    store.save_note(note)
    return NoteResponse(note=note_to_model(note, lambda rel: f"/media/{rel}"))


@app.delete("/api/notes/{note_id}")
def delete_note(note_id: str) -> dict[str, object]:
    store.delete_note(note_id)
    return {"ok": True, "noteId": note_id}


@app.delete("/api/notes")
def delete_all_notes() -> dict[str, object]:
    store.delete_all_notes()
    return {"ok": True}


@app.get("/api/reports/technical", response_model=ReportResponse)
def export_technical_report() -> ReportResponse:
    current_settings = get_settings().model_dump()
    notes = [note_to_model(note, lambda rel: f"/media/{rel}").model_dump() for note in store.list_notes()]
    report = [
        "# BrainSession Technical Report",
        "",
        f"- Generated at: {utc_now()}",
        f"- Notes: {len(notes)}",
        f"- Data dir: {config.data_dir}",
        f"- Media dir: {config.media_dir}",
        "",
        "## Settings",
        "",
        json.dumps(current_settings, ensure_ascii=False, indent=2),
        "",
        "## Notes",
        "",
    ]
    for note in notes:
        report.extend(
            [
                f"### {note['title']}",
                f"- ID: {note['id']}",
                f"- Updated: {note['updatedAt']}",
                f"- Summary: {note['summary']}",
                f"- Entries: {len(note.get('entries', []))}",
                "",
            ]
        )
    markdown = "\n".join(report).strip() + "\n"
    file_name = f"brainsession-technical-report-{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"
    return ReportResponse(ok=True, reportMarkdown=markdown, fileName=file_name)


@app.get("/")
def root() -> Response:
    index_file = config.frontend_dist_dir / "index.html"
    if index_file.exists():
        return HTMLResponse(index_file.read_text(encoding="utf-8"))
    return PlainTextResponse(
        "BrainSession PWA backend is running. Build the frontend with `npm run build` first.",
        status_code=200,
    )


if config.frontend_dist_dir.exists():
    app.mount("/media", StaticFiles(directory=str(config.media_dir), html=False), name="media")
    app.mount("/", StaticFiles(directory=str(config.frontend_dist_dir), html=True), name="frontend")


def main() -> None:
    import uvicorn

    ssl_certfile = os.getenv("SSL_CERTFILE", "").strip() or None
    ssl_keyfile = os.getenv("SSL_KEYFILE", "").strip() or None
    ssl_kwargs: dict[str, object] = {}
    if ssl_certfile and ssl_keyfile:
        ssl_kwargs = {
            "ssl_certfile": ssl_certfile,
            "ssl_keyfile": ssl_keyfile,
        }

    uvicorn.run(
        "backend.main:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=config.port,
        reload=os.getenv("UVICORN_RELOAD", "0") == "1",
        log_level="info",
        proxy_headers=True,
        forwarded_allow_ips="*",
        **ssl_kwargs,
    )


if __name__ == "__main__":
    main()
