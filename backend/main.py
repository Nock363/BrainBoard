from __future__ import annotations

import json
import mimetypes
import os
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from backend.ai import (
    generate_follow_up_question,
    infer_local_interpretation,
    infer_tags,
    interpret_text_note,
    normalize_question_key,
    summarize_note_timeline,
    transcribe_audio,
)
from backend.config import get_config
from backend.models import (
    AppendTextRequest,
    CreateTextNoteRequest,
    DismissFollowUpRequest,
    NoteNode,
    NoteResponse,
    NotesResponse,
    NoteSummarySections,
    NoteTimelineEntry,
    ReportResponse,
    SettingsResponse,
    ToggleTodoRequest,
    UpdateSettingsRequest,
)
from backend.storage import BrainSessionStore


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def make_note_id() -> str:
    return f"note_{uuid4().hex[:12]}"


def make_entry_id() -> str:
    return f"entry_{uuid4().hex[:12]}"


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
    summary_sections = note.get("summarySections", {}) if isinstance(note.get("summarySections", {}), dict) else {}
    reviews = note.get("followUpQuestionReviews", [])
    return NoteNode(
        id=str(note.get("id", "")),
        title=str(note.get("title", "")),
        summary=str(note.get("summary", "")),
        rawTranscript=str(note.get("rawTranscript", "")),
        bullets=[str(item) for item in note.get("bullets", []) if str(item).strip()],
        tags=[str(item) for item in note.get("tags", []) if str(item).strip()],
        summarySections=NoteSummarySections(
            todos=[str(item) for item in summary_sections.get("todos", []) if str(item).strip()],
            todoStates=[bool(item) for item in summary_sections.get("todoStates", [])],
            milestones=[str(item) for item in summary_sections.get("milestones", []) if str(item).strip()],
            questions=[str(item) for item in summary_sections.get("questions", []) if str(item).strip()],
        ),
        followUpQuestionReviews=[
            {
                "question": str(review.get("question", "")),
                "reason": str(review.get("reason", "")),
                "createdAt": str(review.get("createdAt", "")),
            }
            for review in reviews
            if isinstance(review, dict)
        ],
        audioRelativePath=str(note.get("audioRelativePath", "")),
        entries=entries,
        createdAt=str(note.get("createdAt", "")),
        updatedAt=str(note.get("updatedAt", "")),
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
    }


def build_note_from_text(
    text: str,
    *,
    api_key: str,
    summary_model: str,
    create_entry_kind: str = "text",
    audio_relative_path: str = "",
    transcription_state: str = "done",
    transcription_error: str = "",
) -> dict[str, object]:
    interpretation = interpret_text_note(api_key, summary_model, text)
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
    sections = {
        "todos": interpretation.get("todos", []),
        "todoStates": [False for _ in interpretation.get("todos", [])],
        "milestones": interpretation.get("milestones", []),
        "questions": interpretation.get("questions", []),
    }
    return {
        "id": note_id,
        "title": interpretation.get("title", "Neue Notiz"),
        "summary": interpretation.get("summary", text.strip()),
        "rawTranscript": text.strip(),
        "bullets": interpretation.get("bullets", []),
        "tags": interpretation.get("tags", infer_tags(text)),
        "summarySections": sections,
        "followUpQuestionReviews": [],
        "audioRelativePath": audio_relative_path,
        "entries": [entry],
        "createdAt": now,
        "updatedAt": now,
    }


def recompute_summary(
    note: dict[str, object],
    *,
    api_key: str,
    summary_model: str,
    follow_up_model: str | None,
    excluded_questions: list[str],
) -> dict[str, object]:
    entries = [str(entry.get("transcript", "")).strip() for entry in note.get("entries", []) if isinstance(entry, dict)]
    entries = [item for item in entries if item]
    if not entries:
        return note
    sections = note.get("summarySections", {}) if isinstance(note.get("summarySections", {}), dict) else {}
    summary_result = summarize_note_timeline(
        api_key=api_key,
        model=summary_model,
        note_title=str(note.get("title", "")),
        entry_transcripts=entries,
        current_sections=sections,
        excluded_questions=excluded_questions,
    )
    if summary_result.get("questions") is None:
        summary_result["questions"] = []
    current_todos = summary_result.get("todos", [])
    current_states = summary_result.get("todoStates", [])
    if len(current_states) != len(current_todos):
        current_states = [False for _ in current_todos]
    note["summary"] = summary_result.get("summary", note.get("summary", ""))
    note["summarySections"] = {
        "todos": current_todos,
        "todoStates": current_states,
        "milestones": summary_result.get("milestones", []),
        "questions": summary_result.get("questions", []),
    }
    note["rawTranscript"] = "\n".join(entries)
    return note


def note_excluded_questions(note: dict[str, object]) -> list[str]:
    excluded = [str(item) for item in note.get("summarySections", {}).get("questions", [])]
    excluded.extend(str(review.get("question", "")) for review in note.get("followUpQuestionReviews", []) if isinstance(review, dict))
    return [item for item in excluded if item.strip()]


config = get_config()
store = BrainSessionStore(config.data_dir, config.db_path, config.settings_path, config.media_dir)

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
    store.save_settings(current)
    return get_settings()


@app.get("/api/notes", response_model=NotesResponse)
def list_notes() -> NotesResponse:
    return NotesResponse(notes=[note_to_model(note, lambda rel: f"/media/{rel}") for note in store.list_notes()])


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
            "summary": "",
            "rawTranscript": "",
            "bullets": [],
            "tags": [],
            "summarySections": {"todos": [], "todoStates": [], "milestones": [], "questions": []},
            "followUpQuestionReviews": [],
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
                create_entry_kind="voice",
                audio_relative_path=relative_path,
            )
            note_result["id"] = str(note["id"])
            note_result["entries"] = [entry]
            note_result["audioRelativePath"] = relative_path
            note_result["createdAt"] = note["createdAt"]
            note_result["updatedAt"] = utc_now()
            note_result["followUpQuestionReviews"] = []
            note_result["summarySections"] = {
                "todos": note_result.get("summarySections", {}).get("todos", []),
                "todoStates": note_result.get("summarySections", {}).get("todoStates", []),
                "milestones": note_result.get("summarySections", {}).get("milestones", []),
                "questions": note_result.get("summarySections", {}).get("questions", []),
            }
            note = note_result
        else:
            interpretation = infer_local_interpretation(transcript)
            if not str(note.get("title", "")).strip():
                note["title"] = interpretation["title"]
            if not note.get("summary"):
                note["summary"] = interpretation["summary"]
            note["bullets"] = note.get("bullets") or interpretation["bullets"]
            note["tags"] = note.get("tags") or interpretation["tags"]
            note = recompute_summary(
                note,
                api_key=api_key,
                summary_model=summary_model,
                follow_up_model=str(current_settings.get("followUpModel") or ""),
                excluded_questions=note_excluded_questions(note),
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
            note = recompute_summary(
                note,
                api_key=api_key,
                summary_model=summary_model,
                follow_up_model=str(current_settings.get("followUpModel") or ""),
                excluded_questions=note_excluded_questions(note),
            )
        except Exception:
            pass
    else:
        interpretation = infer_local_interpretation("\n".join(transcripts))
        note["summary"] = note.get("summary") or interpretation["summary"]
        note["title"] = note.get("title") or interpretation["title"]
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
        raise HTTPException(status_code=400, detail="Keine Einträge für diese Notiz vorhanden")
    if api_key:
        note = recompute_summary(
            note,
            api_key=api_key,
            summary_model=summary_model,
            follow_up_model=str(current_settings.get("followUpModel") or ""),
            excluded_questions=note_excluded_questions(note),
        )
    else:
        interpretation = infer_local_interpretation("\n".join(transcripts))
        note["summary"] = interpretation["summary"]
        note["summarySections"] = {
            "todos": interpretation["todos"],
            "todoStates": [False for _ in interpretation["todos"]],
            "milestones": interpretation["milestones"],
            "questions": interpretation["questions"],
        }
    note["updatedAt"] = utc_now()
    store.save_note(note)
    return NoteResponse(note=note_to_model(note, lambda rel: f"/media/{rel}"))


@app.post("/api/notes/{note_id}/todos/{todo_index}/toggle", response_model=NoteResponse)
def toggle_todo(note_id: str, todo_index: int, payload: ToggleTodoRequest) -> NoteResponse:
    note = store.get_note(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note nicht gefunden")
    sections = note.get("summarySections", {})
    todos = list(sections.get("todos", []))
    if todo_index < 0 or todo_index >= len(todos):
        raise HTTPException(status_code=400, detail="Todo Index ist ungueltig")
    states = list(sections.get("todoStates", []))
    while len(states) < len(todos):
        states.append(False)
    states[todo_index] = bool(payload.checked)
    sections["todoStates"] = states
    note["summarySections"] = sections
    note["updatedAt"] = utc_now()
    store.save_note(note)
    return NoteResponse(note=note_to_model(note, lambda rel: f"/media/{rel}"))


@app.post("/api/notes/{note_id}/follow-up/{question_index}/dismiss", response_model=NoteResponse)
def dismiss_follow_up(note_id: str, question_index: int, payload: DismissFollowUpRequest) -> NoteResponse:
    current_settings = {**default_settings(config), **store.load_settings()}
    api_key = str(current_settings.get("openAiApiKey") or "")
    follow_up_model = str(current_settings.get("followUpModel") or config.follow_up_model)
    summary_model = str(current_settings.get("summaryModel") or config.summary_model)
    note = store.get_note(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note nicht gefunden")
    sections = note.get("summarySections", {})
    questions = list(sections.get("questions", []))
    if question_index < 0 or question_index >= len(questions):
        raise HTTPException(status_code=400, detail="Fragenindex ist ungueltig")
    removed_question = questions.pop(question_index)
    reviews = list(note.get("followUpQuestionReviews", []))
    reviews.append({"question": removed_question, "reason": payload.reason, "createdAt": utc_now()})
    note["followUpQuestionReviews"] = reviews
    replacement = ""
    if api_key:
        replacement = generate_follow_up_question(
            api_key=api_key,
            model=follow_up_model,
            note_title=str(note.get("title", "")),
            note_summary=str(note.get("summary", "")),
            existing_questions=questions,
            dismissed_question=removed_question,
            dismissed_reason=payload.reason,
            excluded_questions=note_excluded_questions(note),
        )
    if replacement and normalize_question_key(replacement) not in {normalize_question_key(item) for item in questions}:
        questions.append(replacement)
    note["summarySections"] = {**sections, "questions": questions[:5]}
    note["updatedAt"] = utc_now()
    store.save_note(note)
    return NoteResponse(note=note_to_model(note, lambda rel: f"/media/{rel}"))


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
        follow_up_model=str(current_settings.get("followUpModel") or ""),
        excluded_questions=note_excluded_questions(note),
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
    app.mount("/", StaticFiles(directory=str(config.frontend_dist_dir), html=True), name="frontend")


def main() -> None:
    import uvicorn

    uvicorn.run(
        "backend.main:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=config.port,
        reload=os.getenv("UVICORN_RELOAD", "0") == "1",
        log_level="info",
    )


if __name__ == "__main__":
    main()

