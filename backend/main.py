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
    generate_inspiration_suggestion,
    group_notes_by_theme,
    interpret_text_note,
    set_llm_logger,
    summarize_note_timeline,
    transcribe_audio,
    DEFAULT_CATEGORY_PROMPT_PREFIX,
    DEFAULT_GROUP_PROMPT_PREFIX,
    DEFAULT_TRANSCRIPTION_PROMPT,
    DEFAULT_SUMMARY_PROMPT_PREFIX,
)
from backend.config import get_config
from backend.models import (
    AppendTextRequest,
    BoardGroupItem,
    BoardGroupDraft,
    BoardGroupsResponse,
    BoardGroupsSaveRequest,
    CreateTextNoteRequest,
    NoteNode,
    NoteResponse,
    NotesResponse,
    NoteTimelineEntry,
    LlmLogsResponse,
    InspirationResponse,
    ReportResponse,
    RoutineResponse,
    SettingsResponse,
    UpdateNoteCategoryRequest,
    UpdateNoteTranscriptRequest,
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


def clean_note_id_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    note_ids: list[str] = []
    seen_note_ids: set[str] = set()
    for item in value:
        note_id = clean_text_value(item)
        if not note_id or note_id in seen_note_ids:
            continue
        seen_note_ids.add(note_id)
        note_ids.append(note_id)
    return note_ids


def clean_board_group_source(value: object) -> str:
    source = clean_text_value(value).lower()
    if source in {"auto", "manual"}:
        return source
    return "auto"


def normalize_board_group(group: dict[str, object], index: int, default_source: str = "auto") -> dict[str, object]:
    source = clean_board_group_source(group.get("source", default_source))
    return {
        "key": clean_text_value(group.get("key")) or f"group-{index}",
        "title": clean_text_value(group.get("title")),
        "description": clean_text_value(group.get("description")),
        "source": source,
        "noteIds": clean_note_id_list(group.get("noteIds", [])),
    }


def resolve_note_category(note: dict[str, object]) -> str:
    if "manualCategory" in note:
        manual_category = validate_note_category(clean_text_value(note.get("manualCategory")))
        if manual_category:
            return manual_category

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
        rawTranscript=resolved_note_transcript(note),
        category=resolve_note_category(note),
        audioRelativePath=clean_text_value(note.get("audioRelativePath")),
        entries=entries,
        createdAt=clean_text_value(note.get("createdAt")),
        updatedAt=clean_text_value(note.get("updatedAt")),
    )


def note_transcript_segments(note: dict[str, object]) -> list[str]:
    manual_transcript = clean_text_value(note.get("manualTranscript"))
    if manual_transcript:
        return [manual_transcript]
    transcripts = [
        str(entry.get("transcript", "")).strip()
        for entry in note.get("entries", [])
        if isinstance(entry, dict) and str(entry.get("transcript", "")).strip()
    ]
    if transcripts:
        return transcripts
    raw_transcript = clean_text_value(note.get("rawTranscript"))
    return [raw_transcript] if raw_transcript else []


def resolved_note_transcript(note: dict[str, object]) -> str:
    return "\n".join(note_transcript_segments(note))


def build_board_groups_response(group_defs: list[dict[str, object]], notes: list[dict[str, object]]) -> BoardGroupsResponse:
    note_map = {
        str(note.get("id", "")): note
        for note in notes
        if isinstance(note, dict) and str(note.get("id", "")).strip()
    }
    normalized_groups = [normalize_board_group(group, index) for index, group in enumerate(group_defs) if isinstance(group, dict)]
    manual_note_ids = {
        note_id
        for group in normalized_groups
        if group["source"] == "manual"
        for note_id in group["noteIds"]
    }
    seen_note_ids: set[str] = set()
    response_groups: list[BoardGroupItem] = []

    for index, group in enumerate(normalized_groups):
        group_title = group["title"] or f"Gruppe {index + 1}"
        group_description = group["description"]
        group_source = group["source"]
        group_key = group["key"]
        group_notes: list[NoteNode] = []
        if group_key == "group-unassigned" or group_title == "Nicht zugeordnet":
            continue
        for note_id in group["noteIds"]:
            clean_note_id = clean_text_value(note_id)
            if not clean_note_id or clean_note_id in seen_note_ids or clean_note_id in manual_note_ids:
                continue
            note = note_map.get(clean_note_id)
            if note is None:
                continue
            seen_note_ids.add(clean_note_id)
            group_notes.append(note_to_model(note, lambda rel: f"/media/{rel}"))
        if group_source == "auto" and len(group_notes) < 2:
            continue
        if group_source == "manual":
            for note_id in group["noteIds"]:
                clean_note_id = clean_text_value(note_id)
                if clean_note_id:
                    seen_note_ids.add(clean_note_id)
        response_groups.append(
            BoardGroupItem(
                key=group_key or f"group-{index}-{re.sub(r'[^a-z0-9]+', '-', group_title.lower()).strip('-') or 'board'}",
                title=group_title,
                description=group_description,
                source=group_source, 
                notes=group_notes,
            )
        )

    unassigned_notes = [note for note in notes if str(note.get("id", "")) not in seen_note_ids]
    if unassigned_notes:
        response_groups.append(
            BoardGroupItem(
                key="group-unassigned",
                title="Nicht zugeordnet",
                description="Notizen ohne eindeutige thematische Gruppe.",
                source="auto",
                notes=[note_to_model(note, lambda rel: f"/media/{rel}") for note in unassigned_notes],
            )
        )

    if not response_groups and notes:
        response_groups.append(
            BoardGroupItem(
                key="group-empty",
                title="Nicht zugeordnet",
                description="Keine gespeicherten Gruppen vorhanden.",
                source="auto",
                notes=[note_to_model(note, lambda rel: f"/media/{rel}") for note in notes],
            )
        )

    return BoardGroupsResponse(groups=response_groups)


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
        "transcriptionPrompt": DEFAULT_TRANSCRIPTION_PROMPT,
        "summaryPromptPrefix": DEFAULT_SUMMARY_PROMPT_PREFIX,
        "categoryPromptPrefix": DEFAULT_CATEGORY_PROMPT_PREFIX,
        "groupPromptPrefix": DEFAULT_GROUP_PROMPT_PREFIX,
    }


def category_prompt_prefix_from(settings: dict[str, object]) -> str:
    return clean_text_value(settings.get("categoryPromptPrefix")) or DEFAULT_CATEGORY_PROMPT_PREFIX


def group_prompt_prefix_from(settings: dict[str, object]) -> str:
    return clean_text_value(settings.get("groupPromptPrefix")) or DEFAULT_GROUP_PROMPT_PREFIX


def summary_prompt_prefix_from(settings: dict[str, object]) -> str:
    return clean_text_value(settings.get("summaryPromptPrefix")) or DEFAULT_SUMMARY_PROMPT_PREFIX


def transcription_prompt_from(settings: dict[str, object]) -> str:
    return clean_text_value(settings.get("transcriptionPrompt")) or DEFAULT_TRANSCRIPTION_PROMPT


def build_note_from_text(
    text: str,
    *,
    api_key: str,
    summary_model: str,
    summary_prompt_prefix: str,
    category_prompt_prefix: str,
    create_entry_kind: str = "text",
    audio_relative_path: str = "",
    transcription_state: str = "done",
    transcription_error: str = "",
) -> dict[str, object]:
    summary_result = interpret_text_note(api_key, summary_model, text, summary_prompt_prefix)
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
    summary_prompt_prefix: str,
    category_prompt_prefix: str,
) -> dict[str, object]:
    transcripts = note_transcript_segments(note)
    if not transcripts:
        raise ValueError("Keine Eintraege fuer diese Notiz vorhanden")
    note = recompute_summary(
        note,
        api_key=api_key,
        summary_model=summary_model,
        summary_prompt_prefix=summary_prompt_prefix,
        category_prompt_prefix=category_prompt_prefix,
    )
    return note


def recompute_summary(
    note: dict[str, object],
    *,
    api_key: str,
    summary_model: str,
    summary_prompt_prefix: str,
    category_prompt_prefix: str,
) -> dict[str, object]:
    entries = note_transcript_segments(note)
    if not entries:
        return note
    summary_result = summarize_note_timeline(
        api_key=api_key,
        model=summary_model,
        note_title=clean_text_value(note.get("title")),
        entry_transcripts=entries,
        prompt_prefix=summary_prompt_prefix,
    )
    summary_headline = clean_text_value(summary_result.get("summaryHeadline")) or clean_text_value(note.get("title")) or "Neue Notiz"
    note["summary"] = clean_text_value(summary_result.get("summary")) or clean_text_value(note.get("summary"))
    note["title"] = summary_headline
    note["summaryHeadline"] = summary_headline
    next_category = classify_note_category(api_key, summary_model, category_prompt_prefix, note["summary"])
    if next_category:
        note["category"] = next_category
    note["rawTranscript"] = "\n".join(entries)
    return note


config = get_config()
store = BrainSessionStore(config.data_dir, config.db_path, config.settings_path, config.media_dir)
set_llm_logger(store.save_llm_log)


def normalize_note_categories() -> None:
    for note in store.list_notes():
        category = clean_text_value(note.get("category"))
        if category not in {"Idea", "Task"}:
            continue
        if clean_text_value(note.get("manualCategory")) == category:
            continue
        note["manualCategory"] = category
        note["updatedAt"] = utc_now()
        store.save_note(note)


normalize_note_categories()

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
        transcriptionPrompt=transcription_prompt_from(current),
        summaryPromptPrefix=summary_prompt_prefix_from(current),
        categoryPromptPrefix=category_prompt_prefix_from(current),
        groupPromptPrefix=group_prompt_prefix_from(current),
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
    if payload.transcriptionPrompt is not None:
        current["transcriptionPrompt"] = payload.transcriptionPrompt.strip() or DEFAULT_TRANSCRIPTION_PROMPT
    if payload.summaryPromptPrefix is not None:
        current["summaryPromptPrefix"] = payload.summaryPromptPrefix.strip() or DEFAULT_SUMMARY_PROMPT_PREFIX
    if payload.categoryPromptPrefix is not None:
        current["categoryPromptPrefix"] = payload.categoryPromptPrefix.strip() or DEFAULT_CATEGORY_PROMPT_PREFIX
    if payload.groupPromptPrefix is not None:
        current["groupPromptPrefix"] = payload.groupPromptPrefix.strip() or DEFAULT_GROUP_PROMPT_PREFIX
    store.save_settings(current)
    return get_settings()


@app.get("/api/notes", response_model=NotesResponse)
def list_notes() -> NotesResponse:
    return NotesResponse(notes=[note_to_model(note, lambda rel: f"/media/{rel}") for note in store.list_notes()])


@app.get("/api/board-groups", response_model=BoardGroupsResponse)
def list_board_groups() -> BoardGroupsResponse:
    stored_groups = store.load_board_groups()
    if not stored_groups:
        return BoardGroupsResponse(groups=[])
    return build_board_groups_response(stored_groups, store.list_notes())


@app.put("/api/board-groups", response_model=BoardGroupsResponse)
def save_board_groups(payload: BoardGroupsSaveRequest) -> BoardGroupsResponse:
    groups = [
        {
            "key": group.key,
            "title": group.title,
            "description": group.description,
            "source": group.source,
            "noteIds": group.noteIds,
        }
        for group in payload.groups
        if clean_text_value(group.title)
        and (
            clean_board_group_source(group.source) == "manual"
            or len([note_id for note_id in group.noteIds if clean_text_value(note_id)]) >= 2
        )
    ]
    store.save_board_groups(groups)
    return build_board_groups_response(groups, store.list_notes())


@app.post("/api/routines/group-notes", response_model=BoardGroupsResponse)
def group_notes() -> BoardGroupsResponse:
    current_settings = {**default_settings(config), **store.load_settings()}
    api_key = str(current_settings.get("openAiApiKey") or config.openai_api_key or "")
    summary_model = str(current_settings.get("summaryModel") or config.summary_model)
    group_prompt_prefix = group_prompt_prefix_from(current_settings)
    notes = store.list_notes()
    stored_groups = store.load_board_groups()
    manual_groups = [
        normalize_board_group(group, index, default_source="auto")
        for index, group in enumerate(stored_groups)
        if isinstance(group, dict) and clean_board_group_source(group.get("source", "auto")) == "manual"
    ]
    manual_note_ids = {
        note_id
        for group in manual_groups
        for note_id in group["noteIds"]
    }
    grouped_notes = group_notes_by_theme(
        api_key=api_key,
        model=summary_model,
        prompt_prefix=group_prompt_prefix,
        notes=[note for note in notes if str(note.get("id", "")) not in manual_note_ids],
    )
    auto_groups = [
        {
            **group,
            "source": "auto",
        }
        for group in grouped_notes
    ]
    combined_groups = [*manual_groups, *auto_groups]
    store.save_board_groups(combined_groups)
    return build_board_groups_response(combined_groups, notes)


@app.get("/api/llm-logs", response_model=LlmLogsResponse)
def list_llm_logs(limit: int = 100) -> LlmLogsResponse:
    return LlmLogsResponse(logs=store.list_llm_logs(limit))


@app.api_route("/api/inspiration", methods=["GET", "POST"], response_model=InspirationResponse)
def create_inspiration() -> InspirationResponse:
    current_settings = {**default_settings(config), **store.load_settings()}
    api_key = str(current_settings.get("openAiApiKey") or config.openai_api_key or "")
    follow_up_model = str(current_settings.get("followUpModel") or config.follow_up_model)
    suggestion = generate_inspiration_suggestion(api_key, follow_up_model, store.list_notes())
    return InspirationResponse(**suggestion)


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
        summary_prompt_prefix=summary_prompt_prefix_from(current_settings),
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
    transcription_prompt = transcription_prompt_from(current_settings)
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
            prompt=transcription_prompt,
        )
        entry["transcript"] = transcript
        entry["transcriptionState"] = "done"
        entry["updatedAt"] = utc_now()
        note.pop("manualTranscript", None)
        if new_note:
            note_result = build_note_from_text(
                transcript,
                api_key=api_key,
                summary_model=summary_model,
                summary_prompt_prefix=summary_prompt_prefix_from(current_settings),
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
            summary_result = interpret_text_note(api_key, summary_model, transcript, summary_prompt_prefix_from(current_settings))
            if not clean_text_value(note.get("title")):
                note["title"] = clean_text_value(summary_result.get("summaryHeadline")) or note.get("title", "Neue Notiz")
            if not note.get("summary"):
                note["summary"] = clean_text_value(summary_result.get("summary")) or transcript.strip()
            note = recompute_summary(
                note,
                api_key=api_key,
                summary_model=summary_model,
                summary_prompt_prefix=summary_prompt_prefix_from(current_settings),
                category_prompt_prefix=category_prompt_prefix_from(current_settings),
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
    note.pop("manualTranscript", None)
    note["updatedAt"] = now
    if api_key:
        try:
            note = reanalyze_note(
                note,
                api_key=api_key,
                summary_model=summary_model,
                summary_prompt_prefix=summary_prompt_prefix_from(current_settings),
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
                summary_prompt_prefix=summary_prompt_prefix_from(current_settings),
                category_prompt_prefix=category_prompt_prefix_from(current_settings),
            )
        except Exception:
            summary_result = interpret_text_note("", summary_model, "\n".join(transcripts), summary_prompt_prefix_from(current_settings))
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
        summary_prompt_prefix=summary_prompt_prefix_from(current_settings),
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
        if validated_category:
            note["manualCategory"] = validated_category
        else:
            note.pop("manualCategory", None)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    note["updatedAt"] = utc_now()
    store.save_note(note)
    return NoteResponse(note=note_to_model(note, lambda rel: f"/media/{rel}"))


@app.put("/api/notes/{note_id}/transcript", response_model=NoteResponse)
def update_note_transcript(note_id: str, payload: UpdateNoteTranscriptRequest) -> NoteResponse:
    current_settings = {**default_settings(config), **store.load_settings()}
    api_key = str(current_settings.get("openAiApiKey") or "")
    summary_model = str(current_settings.get("summaryModel") or config.summary_model)
    note = store.get_note(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note nicht gefunden")

    transcript = payload.transcript.strip()
    note["manualTranscript"] = transcript
    note["rawTranscript"] = transcript
    note = recompute_summary(
        note,
        api_key=api_key,
        summary_model=summary_model,
        summary_prompt_prefix=summary_prompt_prefix_from(current_settings),
        category_prompt_prefix=category_prompt_prefix_from(current_settings),
    )
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
        transcripts = note_transcript_segments(note)
        if not transcripts:
            skipped_notes += 1
            continue
        try:
            note.pop("manualCategory", None)
            note = reanalyze_note(
                note,
                api_key=api_key,
                summary_model=summary_model,
                summary_prompt_prefix=summary_prompt_prefix_from(current_settings),
                category_prompt_prefix=category_prompt_prefix_from(current_settings),
            )
            note["updatedAt"] = utc_now()
            store.save_note(note)
            updated_notes += 1
        except Exception:
            skipped_notes += 1
    return RoutineResponse(ok=True, updatedNotes=updated_notes, skippedNotes=skipped_notes)


@app.post("/api/routines/retranscribe-notes", response_model=RoutineResponse)
def retranscribe_all_notes() -> RoutineResponse:
    current_settings = {**default_settings(config), **store.load_settings()}
    api_key = str(current_settings.get("openAiApiKey") or "")
    summary_model = str(current_settings.get("summaryModel") or config.summary_model)
    transcription_model = str(current_settings.get("transcriptionModel") or config.transcription_model)
    language = str(current_settings.get("language") or config.language)
    transcription_prompt = transcription_prompt_from(current_settings)
    if not api_key:
        raise HTTPException(status_code=400, detail="OpenAI API key fehlt")

    updated_notes = 0
    skipped_notes = 0
    for note in store.list_notes():
        entries = [item for item in note.get("entries", []) if isinstance(item, dict) and item.get("kind") == "voice"]
        if not entries:
            skipped_notes += 1
            continue

        changed = False
        for entry in entries:
            audio_rel = str(entry.get("audioRelativePath", ""))
            if not audio_rel:
                continue
            try:
                transcript = transcribe_audio(
                    api_key=api_key,
                    audio_path=store.media_dir / audio_rel,
                    model=transcription_model,
                    language=language,
                    prompt=transcription_prompt,
                )
            except Exception:
                skipped_notes += 1
                continue

            entry["transcript"] = transcript
            entry["transcriptionState"] = "done"
            entry["transcriptionError"] = ""
            entry["updatedAt"] = utc_now()
            changed = True

        if not changed:
            skipped_notes += 1
            continue

        note.pop("manualTranscript", None)
        transcripts = [
            str(item.get("transcript", "")).strip()
            for item in note.get("entries", [])
            if isinstance(item, dict) and str(item.get("transcript", "")).strip()
        ]
        note["rawTranscript"] = "\n".join(transcripts)
        note = recompute_summary(
            note,
            api_key=api_key,
            summary_model=summary_model,
            summary_prompt_prefix=summary_prompt_prefix_from(current_settings),
            category_prompt_prefix=category_prompt_prefix_from(current_settings),
        )
        note["updatedAt"] = utc_now()
        store.save_note(note)
        updated_notes += 1

    return RoutineResponse(ok=True, updatedNotes=updated_notes, skippedNotes=skipped_notes)


@app.post("/api/notes/{note_id}/entries/{entry_id}/retry", response_model=NoteResponse)
def retry_transcription(note_id: str, entry_id: str) -> NoteResponse:
    current_settings = {**default_settings(config), **store.load_settings()}
    api_key = str(current_settings.get("openAiApiKey") or "")
    summary_model = str(current_settings.get("summaryModel") or config.summary_model)
    transcription_model = str(current_settings.get("transcriptionModel") or config.transcription_model)
    language = str(current_settings.get("language") or config.language)
    transcription_prompt = transcription_prompt_from(current_settings)
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
    try:
        transcript = transcribe_audio(
            api_key=api_key,
            audio_path=store.media_dir / audio_rel,
            model=transcription_model,
            language=language,
            prompt=transcription_prompt,
        )
    except Exception as error:
        entry["transcriptionState"] = "pending_retry"
        entry["transcriptionError"] = str(error)
        entry["updatedAt"] = utc_now()
        note["updatedAt"] = utc_now()
        store.save_note(note)
        return NoteResponse(note=note_to_model(note, lambda rel: f"/media/{rel}"))

    entry["transcript"] = transcript
    entry["transcriptionState"] = "done"
    entry["transcriptionError"] = ""
    entry["updatedAt"] = utc_now()
    note.pop("manualTranscript", None)
    transcripts = [str(item.get("transcript", "")).strip() for item in note.get("entries", []) if isinstance(item, dict) and str(item.get("transcript", "")).strip()]
    note["rawTranscript"] = "\n".join(transcripts)
    note["updatedAt"] = utc_now()
    note = recompute_summary(
        note,
        api_key=api_key,
        summary_model=summary_model,
        summary_prompt_prefix=summary_prompt_prefix_from(current_settings),
        category_prompt_prefix=category_prompt_prefix_from(current_settings),
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
    store.delete_board_groups()
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


@app.get("/desktop")
@app.get("/desktop/")
@app.get("/desktop/{path:path}")
def desktop_frontend(path: str = "") -> Response:
    index_file = config.frontend_dist_dir / "index.html"
    if index_file.exists():
        return HTMLResponse(index_file.read_text(encoding="utf-8"))
    return PlainTextResponse(
        "BrainSession Desktop backend is running. Build the frontend with `npm run build` first.",
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
