from __future__ import annotations

import json
import random
import re
from datetime import datetime, timezone
from collections import Counter
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

import requests


DEFAULT_CATEGORY_PROMPT_PREFIX = (
    "Bitte analysiere folgenden Text auf die Art des Textes. "
    "Es gibt drei Arten: <Idee>, <To-Do> oder <Notiz>. "
    "Antworte nur mit genau einer dieser drei Ausgaben."
)

DEFAULT_GROUP_PROMPT_PREFIX = (
    "Du analysierst alle BrainSession-Notizen und bildest thematische Gruppen für eine Pinnwand. "
    "Eine Gruppe kann Notizen, To-Dos und Ideen gemeinsam enthalten. "
    "Erstelle wenige klare Spalten, die ähnliche Themen, Projekte oder Ziele zusammenfassen. "
    "Gib jeder Gruppe einen kurzen Titel und eine kurze Beschreibung. "
    "Jede Notiz muss genau einer Gruppe zugeordnet werden."
)

DEFAULT_SUMMARY_PROMPT_PREFIX = (
    "Fasse das folgende Transkript zusammen. Die Zusammenfassung soll einen klaren Fließtext darstellen, "
    "indem alles drin steht, was im Transkript stand. Zudem soll eine kurze und prägnante Überschrift erstellt werden. "
    "Ausgeben sollst du es in folgenden Format:\n\n"
    "<headline>...</headline>\n"
    "<text>...</text>"
)

DEFAULT_TRANSCRIPTION_PROMPT = (
    "Das hier ist eine deutsche Sprachmemo für BrainSession. "
    "Transkribiere nur klar hörbare Worte, erfinde nichts dazu und halte den Wortlaut möglichst genau fest. "
    "Bewahre Eigennamen, Zahlen, Abkürzungen, Produktnamen und Aufzählungen. "
    "Wenn etwas unklar ist, lasse es lieber weg statt zu raten."
)

DEFAULT_INSPIRATION_PROMPT_PREFIX = (
    "Du liest alle BrainSession-Notizen als Gesamtheit und findest daraus einen sehr kurzen Gedankenanstoß "
    "für eine freie Minute. Antworte auf Deutsch, sehr knapp und konkret. Gib genau einen kurzen Kontext "
    "und genau eine offene Frage aus."
)


STOP_WORDS = {
    "und",
    "oder",
    "der",
    "die",
    "das",
    "ein",
    "eine",
    "ist",
    "sind",
    "mit",
    "für",
    "fuer",
    "dass",
    "du",
    "ich",
    "wir",
    "was",
    "wie",
    "auf",
    "im",
    "in",
    "am",
    "an",
    "zu",
    "den",
    "dem",
    "des",
    "von",
    "noch",
    "aber",
    "nicht",
    "nur",
    "auch",
    "als",
    "bei",
    "it",
    "the",
}

CATEGORY_ALIASES = {
    "idea": "Idea",
    "ideen": "Idea",
    "idee": "Idea",
    "suggestion": "Idea",
    "task": "Task",
    "to-do": "Task",
    "to do": "Task",
    "todo": "Task",
    "aufgabe": "Task",
    "notiz": "",
}

LLMLogCallback = Callable[[dict[str, Any]], None]

_llm_log_callback: LLMLogCallback | None = None


def set_llm_logger(callback: LLMLogCallback | None) -> None:
    global _llm_log_callback
    _llm_log_callback = callback


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _make_llm_log_entry(kind: str, model: str, messages: list[dict[str, str]], *, note_title: str = "") -> dict[str, Any]:
    return {
        "id": f"llm_{uuid4().hex[:12]}",
        "createdAt": _utc_now(),
        "provider": "openai",
        "kind": kind,
        "model": model,
        "noteTitle": _clean_text(note_title),
        "messages": messages,
    }


def _emit_llm_log(entry: dict[str, Any]) -> None:
    if _llm_log_callback is None:
        return
    try:
        _llm_log_callback(entry)
    except Exception:
        pass


def _normalize_messages(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    normalized: list[dict[str, str]] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = _clean_text(message.get("role", "")) or "meta"
        content = message.get("content", "")
        if isinstance(content, list):
            parts: list[str] = []
            for part in content:
                if isinstance(part, dict):
                    for key in ("text", "value", "output_text"):
                        value = part.get(key)
                        if isinstance(value, str) and value.strip():
                            parts.append(value.strip())
                            break
                else:
                    text = _clean_text(part)
                    if text:
                        parts.append(text)
            content_text = "\n".join(parts).strip()
        else:
            content_text = _clean_text(content)
        normalized.append({"role": role, "content": content_text})
    return normalized


def _format_summary_log(summary_headline: str, summary: str) -> str:
    headline = _clean_text(summary_headline) or "(ohne Überschrift)"
    body = _clean_text(summary) or "(leer)"
    return f"summaryHeadline: {headline}\nsummary: {body}"


def _format_category_log(category: str) -> str:
    display_category = {
        "Idea": "Idee",
        "Task": "To-Do",
        "": "Notiz",
    }.get(category, category or "Notiz")
    return f"category: {display_category}"


def _format_group_log(groups: list[dict[str, Any]]) -> str:
    return json.dumps(
        [
            {
                "title": _clean_text(str(group.get("title", ""))) or "(ohne Titel)",
                "description": _clean_text(str(group.get("description", ""))) or "(ohne Beschreibung)",
                "noteIds": _normalize_list(group.get("noteIds", [])),
            }
            for group in groups
        ],
        ensure_ascii=False,
    )


def _format_question_log(question: str) -> str:
    return f"question: {_clean_text(question) or '(leer)'}"


def _format_inspiration_log(context: str, question: str) -> str:
    short_context = _clean_text(context) or "(leer)"
    short_question = _clean_text(question) or "(leer)"
    return f"context: {short_context}\nquestion: {short_question}"


def _format_transcription_log(text: str) -> str:
    return f"transcript: {_clean_text(text) or '(leer)'}"


def _is_suspicious_transcript(text: str) -> bool:
    clean = _clean_text(text)
    if not clean:
        return True

    words = re.findall(r"[\wÄÖÜäöüß]+", clean.lower())
    if len(words) < 6:
        return False

    unique_words = set(words)
    unique_ratio = len(unique_words) / max(1, len(words))
    if len(words) >= 12 and unique_ratio < 0.35:
        return True

    sentences = [segment.strip() for segment in re.split(r"[.!?]+", clean) if segment.strip()]
    if len(sentences) >= 3:
        normalized_sentences = [re.sub(r"\s+", " ", sentence.lower()) for sentence in sentences]
        most_common_sentence = Counter(normalized_sentences).most_common(1)[0][1]
        if most_common_sentence >= 3:
            return True

    window_size = min(10, len(words) // 2)
    if window_size >= 4:
        windows = [" ".join(words[index : index + window_size]) for index in range(0, len(words) - window_size + 1)]
        if windows and Counter(windows).most_common(1)[0][1] >= 3:
            return True

    return False


def _clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def _normalize_category(value: Any) -> str:
    text = _clean_text(str(value or "")).lower()
    if not text:
        return ""
    text = text.strip("<>")
    normalized = text.replace(" ", "")
    return CATEGORY_ALIASES.get(text, CATEGORY_ALIASES.get(normalized, ""))


def _extract_project_tag(text: str) -> str:
    clean = _clean_text(text)
    if not clean:
        return ""
    match = re.search(r"(?:projekt|project|für|fuer)[:\s]+([A-Za-zÄÖÜäöüß0-9][A-Za-zÄÖÜäöüß0-9 _/-]{2,40})", clean, re.IGNORECASE)
    if match:
        return _clean_text(match.group(1)).rstrip(".,;:")[:48]
    if "/" in clean:
        prefix = clean.split("/")[0].strip()
        if 3 <= len(prefix) <= 40:
            return prefix[:48]
    return ""


def _extract_action_items(text: str, limit: int = 5) -> list[str]:
    clean = _clean_text(text)
    if not clean:
        return []

    candidates: list[str] = []
    for raw_line in re.split(r"[\n\r]+", text):
        line = raw_line.strip().lstrip("-•*0123456789. )\t")
        if not line:
            continue
        if re.search(r"\b(muss|soll|bitte|todo|aufgabe|check|erledigen|planen)\b", line, re.IGNORECASE):
            candidates.append(_clean_text(line).rstrip(".,;:"))

    if not candidates:
        for sentence in re.split(r"(?<=[.!?])\s+", clean):
            if re.search(r"\b(muss|soll|bitte|kannst|naechste|nächste|erledigen)\b", sentence, re.IGNORECASE):
                candidates.append(_clean_text(sentence).rstrip(".,;:"))

    result: list[str] = []
    seen: set[str] = set()
    for item in candidates:
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
        if len(result) >= limit:
            break
    return result


def infer_local_summary(text: str) -> dict[str, Any]:
    clean = _clean_text(text)
    if not clean:
        return {
            "summaryHeadline": "Neue Notiz",
            "summary": "",
        }

    headline = _shorten_headline(clean)
    summary = clean if len(clean) <= 220 else f"{clean[:217].rstrip()}..."

    return {
        "summaryHeadline": headline,
        "summary": summary,
    }


def _shorten_headline(text: str) -> str:
    clean = _clean_text(text)
    return clean or "Neue Notiz"


def _extract_summary_payload(raw_text: str, fallback_text: str) -> dict[str, str]:
    clean_raw = _clean_text(raw_text)
    if not clean_raw:
        return infer_local_summary(fallback_text)

    parsed_headline = ""
    parsed_summary = ""

    try:
        parsed = json.loads(clean_raw)
        if isinstance(parsed, dict):
            parsed_headline = _clean_text(str(parsed.get("headline") or parsed.get("summaryHeadline") or ""))
            parsed_summary = _clean_text(str(parsed.get("text") or parsed.get("summary") or ""))
    except Exception:
        pass

    if not parsed_headline or not parsed_summary:
        match = re.search(r"<headline>(.*?)</headline>\s*<text>(.*?)</text>", raw_text, re.IGNORECASE | re.DOTALL)
        if match:
            parsed_headline = parsed_headline or _clean_text(match.group(1))
            parsed_summary = parsed_summary or _clean_text(match.group(2))

    if not parsed_headline or not parsed_summary:
        fallback = infer_local_summary(fallback_text)
        parsed_headline = parsed_headline or fallback["summaryHeadline"]
        parsed_summary = parsed_summary or fallback["summary"]

    return {
        "summaryHeadline": _shorten_headline(parsed_headline),
        "summary": parsed_summary or _clean_text(fallback_text),
    }


def _summary_prompt_from_prefix(prompt_prefix: str, input_label: str, content: str) -> list[dict[str, str]]:
    clean_prefix = _clean_text(prompt_prefix) or DEFAULT_SUMMARY_PROMPT_PREFIX
    clean_content = _clean_text(content)
    return [
        {
            "role": "system",
            "content": (
                "Du bist ein präziser Zusammenfasser für BrainSession. "
                "Halte dich strikt an das gewünschte Ausgabeformat aus der Nutzeranweisung."
            ),
        },
        {
            "role": "user",
            "content": f"{clean_prefix}\n\n{input_label}:\n{clean_content}",
        },
    ]


def _chat_system_prompt(speech_mode: bool = False) -> str:
    base_prompt = (
        "Du bist der BrainSession-Chatbot und arbeitest auf Deutsch. "
        "Du hast Zugriff auf Notizen, die wie ein RAG-System bereitgestellt werden. "
        "Nutze diese Notizen als primären Kontext, baue auf ihnen auf und antworte knapp, konkret und hilfreich. "
        "Wenn die Notizen nicht reichen, stelle eine kurze Rueckfrage statt etwas zu erfinden. "
        "Neue Notizen oder Gruppen darfst du nur anlegen, wenn der Nutzer das ausdrücklich verlangt. "
        "Bei normalen Fragen, Zusammenfassungen oder Tests musst du actions leer lassen. "
        "Gib niemals rohe JSON-Objekte im Antworttext aus. "
        "Antworte nur als JSON mit reply, references und actions."
    )
    if speech_mode:
        return (
            base_prompt
            + " Schreibe die reply als ruhigen, fließenden Vorlesetext ohne Markdown, ohne Listen, ohne Emojis und ohne harte Zeilenumbrüche. "
            + "Nutze kurze Absätze, maximal drei kurze Sätze oder zwei sehr kurze Absätze, und formuliere so, dass es sich beim Vorlesen natürlich anhört."
        )
    return (
        base_prompt
        + " Die reply darf Markdown verwenden: Absätze, Aufzählungen, nummerierte Listen, Fettung und kurze Code-Einschübe. "
        + "Wenn du Listen ausgibst, schreibe jeden Punkt in eine eigene Zeile."
    )


def _openai_headers(api_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {api_key.strip()}", "Content-Type": "application/json"}


def _extract_output_text(payload: dict[str, Any]) -> str:
    output_text = payload.get("output_text")
    if isinstance(output_text, str) and output_text.strip():
        return output_text.strip()

    output = payload.get("output")
    if isinstance(output, list):
        parts: list[str] = []
        for item in output:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if isinstance(content, list):
                for part in content:
                    if not isinstance(part, dict):
                        continue
                    for key in ("text", "value", "output_text"):
                        value = part.get(key)
                        if isinstance(value, str) and value.strip():
                            parts.append(value.strip())
            for key in ("text", "value"):
                value = item.get(key)
                if isinstance(value, str) and value.strip():
                    parts.append(value.strip())
        if parts:
            return "\n".join(parts).strip()

    choices = payload.get("choices")
    if isinstance(choices, list):
        parts: list[str] = []
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            message = choice.get("message")
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, str) and content.strip():
                    parts.append(content.strip())
        if parts:
            return "\n".join(parts).strip()

    return ""


def _openai_responses(api_key: str, payload: dict[str, Any]) -> dict[str, Any]:
    response = requests.post(
        "https://api.openai.com/v1/responses",
        headers=_openai_headers(api_key),
        json=payload,
        timeout=60,
    )
    response.raise_for_status()
    return response.json()


def _openai_transcribe(
    api_key: str,
    audio_path: Path,
    model: str,
    language: str = "de",
    prompt: str = "",
    temperature: float = 0.0,
) -> str:
    with audio_path.open("rb") as file_handle:
        response = requests.post(
            "https://api.openai.com/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {api_key.strip()}"},
            files={"file": (audio_path.name, file_handle)},
            data={
                "model": model,
                "language": language,
                "temperature": str(temperature),
                **({"prompt": prompt.strip()} if prompt.strip() else {}),
            },
            timeout=180,
        )
    response.raise_for_status()
    payload = response.json()
    text = str(payload.get("text", "")).strip()
    if not text:
        raise RuntimeError("OpenAI Whisper hat kein Transkript geliefert")
    return text


def _openai_speech(api_key: str, text: str, model: str, voice: str = "alloy") -> bytes:
    response = requests.post(
        "https://api.openai.com/v1/audio/speech",
        headers=_openai_headers(api_key),
        json={
            "model": model.strip() or "gpt-4o-mini-tts",
            "input": text,
            "voice": voice,
            "response_format": "mp3",
        },
        timeout=180,
    )
    response.raise_for_status()
    if not response.content:
        raise RuntimeError("OpenAI Speech hat keine Audiodaten geliefert")
    return response.content


def synthesize_chat_reply_audio(api_key: str, text: str, model: str = "gpt-4o-mini-tts", voice: str = "alloy") -> bytes:
    clean_text = _clean_text(text)
    if not clean_text:
        raise ValueError("Vorlesetext ist leer")
    return _openai_speech(api_key, clean_text, model=model, voice=voice)


def _build_summary_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "summaryHeadline": {"type": "string"},
            "summary": {"type": "string"},
        },
        "required": ["summaryHeadline", "summary"],
    }


def _build_category_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "category": {"type": "string"},
        },
        "required": ["category"],
    }


def _build_group_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "groups": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "title": {"type": "string"},
                        "description": {"type": "string"},
                        "noteIds": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                    "required": ["title", "description", "noteIds"],
                },
            }
        },
        "required": ["groups"],
    }


def _build_inspiration_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "noteId": {"type": "string"},
            "noteTitle": {"type": "string"},
            "context": {"type": "string"},
            "question": {"type": "string"},
        },
        "required": ["noteId", "noteTitle", "context", "question"],
    }


def _build_chat_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "reply": {"type": "string"},
            "references": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "noteId": {"type": "string"},
                        "noteTitle": {"type": "string"},
                        "reason": {"type": "string"},
                    },
                    "required": ["noteId", "noteTitle", "reason"],
                },
            },
            "actions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "type": {"type": "string"},
                        "text": {"type": "string"},
                        "title": {"type": "string"},
                        "description": {"type": "string"},
                        "noteIds": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                    "required": ["type", "text", "title", "description", "noteIds"],
                },
            },
        },
        "required": ["reply", "references", "actions"],
    }


def _chat_excerpt(value: str, limit: int = 320) -> str:
    clean = _clean_text(value)
    if len(clean) <= limit:
        return clean
    return f"{clean[: limit - 1].rstrip()}…"


def _chat_note_payload(note: dict[str, Any]) -> dict[str, Any]:
    note_id = _clean_text(str(note.get("id", "")))
    title = _clean_text(str(note.get("title", ""))) or "Neue Notiz"
    summary = _clean_text(str(note.get("summary", "")))
    raw_transcript = _clean_text(str(note.get("rawTranscript", "")))
    category = {
        "Idea": "Idee",
        "Task": "To-Do",
        "": "Notiz",
    }.get(_normalize_category(note.get("category")), "Notiz")
    return {
        "id": note_id,
        "title": title,
        "category": category,
        "summary": _chat_excerpt(summary or raw_transcript or title, 420),
    }


def _chat_message_blob(messages: list[dict[str, str]]) -> str:
    parts: list[str] = []
    for message in messages[-12:]:
        role = _clean_text(message.get("role", "user")) or "user"
        content = _chat_excerpt(message.get("content", ""), 500)
        if content:
            parts.append(f"{role}: {content}")
    return "\n".join(parts)


def rank_notes_for_query(notes: list[dict[str, Any]], query: str, limit: int = 8) -> list[dict[str, Any]]:
    clean_query = _clean_text(query)
    query_tokens = [token for token in re.findall(r"[\wÄÖÜäöüß]+", clean_query.lower()) if len(token) >= 3]
    if not notes:
        return []

    if not query_tokens:
        return [note for note in notes if _clean_text(str(note.get("id", "")))][:limit]

    ranked: list[tuple[float, dict[str, Any]]] = []
    for note in notes:
        note_id = _clean_text(str(note.get("id", "")))
        if not note_id:
            continue
        haystack_title = _clean_text(str(note.get("title", ""))).lower()
        haystack_summary = _clean_text(str(note.get("summary", ""))).lower()
        haystack_transcript = _clean_text(str(note.get("rawTranscript", ""))).lower()
        haystack = f"{haystack_title} {haystack_summary} {haystack_transcript}"
        score = 0.0
        for token in query_tokens:
            if token in haystack_title:
                score += 4.0
            if token in haystack_summary:
                score += 2.0
            if token in haystack_transcript:
                score += 1.0
        try:
            updated_at = datetime.fromisoformat(str(note.get("updatedAt", "")).replace("Z", "+00:00"))
            score += max(0.0, 1.0 - (datetime.now(timezone.utc) - updated_at).total_seconds() / 86_400_000)
        except Exception:
            pass
        if score > 0:
            ranked.append((score, note))

    ranked.sort(key=lambda item: item[0], reverse=True)
    return [item[1] for item in ranked[:limit]] or [note for note in notes if _clean_text(str(note.get("id", "")))][:limit]


def _compact_note_group_payload(note: dict[str, Any]) -> dict[str, Any]:
    note_id = _clean_text(str(note.get("id", "")))
    title = _clean_text(str(note.get("title", ""))) or "Neue Notiz"
    summary_headline = _clean_text(str(note.get("summaryHeadline", "")))
    summary = _clean_text(str(note.get("summary", "")))
    raw_transcript = _clean_text(str(note.get("rawTranscript", "")))
    note_type = {
        "Idea": "Idee",
        "Task": "To-Do",
        "": "Notiz",
    }.get(_normalize_category(note.get("category")), "Notiz")
    body = summary or raw_transcript or summary_headline
    if len(body) > 700:
        body = f"{body[:697].rstrip()}..."
    return {
        "id": note_id,
        "type": note_type,
        "title": title,
        "summaryHeadline": summary_headline,
        "body": body,
    }


def _compact_inspiration_payload(note: dict[str, Any]) -> dict[str, Any]:
    note_id = _clean_text(str(note.get("id", "")))
    title = _clean_text(str(note.get("title", ""))) or "Neue Notiz"
    summary_headline = _clean_text(str(note.get("summaryHeadline", "")))
    summary = _clean_text(str(note.get("summary", "")))
    raw_transcript = _clean_text(str(note.get("rawTranscript", "")))
    note_type = {
        "Idea": "Idee",
        "Task": "To-Do",
        "": "Notiz",
    }.get(_normalize_category(note.get("category")), "Notiz")
    body = summary or raw_transcript or summary_headline
    if len(body) > 360:
        body = f"{body[:357].rstrip()}..."
    return {
        "id": note_id,
        "noteId": note_id,
        "type": note_type,
        "title": title,
        "summaryHeadline": summary_headline,
        "body": body,
    }


def _note_inspiration_title(note: dict[str, Any]) -> str:
    title = _clean_text(str(note.get("title", ""))) or _clean_text(str(note.get("summaryHeadline", "")))
    return title or "deine Notiz"


def _note_inspiration_context(note: dict[str, Any]) -> str:
    note_type = {
        "Idea": "Idee",
        "Task": "To-Do",
        "": "Notiz",
    }.get(_normalize_category(note.get("category")), "Notiz")
    title = _note_inspiration_title(note)
    summary = _clean_text(str(note.get("summary", "")))
    if summary:
        first_clause = summary.split(".")[0].strip()
        if first_clause:
            return f"{note_type} · {title}: {first_clause}."
    return f"{note_type} · {title}."


def infer_local_inspiration(note: dict[str, Any] | None, notes: list[dict[str, Any]]) -> dict[str, str]:
    clean_notes = [note for note in notes if _clean_text(str(note.get("id", "")))]
    if note is None:
        if not clean_notes:
            return {
                "noteId": "",
                "noteTitle": "",
                "context": "Noch keine Notizen gespeichert.",
                "question": "Worüber möchtest du als Nächstes nachdenken?",
            }
        note = random.choice(clean_notes)

    note_title = _note_inspiration_title(note)
    note_type = {
        "Idea": "Idee",
        "Task": "To-Do",
        "": "Notiz",
    }.get(_normalize_category(note.get("category")), "Notiz")
    summary = _clean_text(str(note.get("summary", ""))).lower()
    transcript = _clean_text(str(note.get("rawTranscript", ""))).lower()
    combined = f"{summary} {transcript} {note_title.lower()}"

    if not clean_notes:
        return {
            "noteId": "",
            "noteTitle": "",
            "context": "Noch keine Notizen gespeichert.",
            "question": "Worüber möchtest du als Nächstes nachdenken?",
        }

    if "weltraum" in combined or "weltraum" in combined or "raumschiff" in combined or "planet" in combined:
        question = "Wie soll dein Hauptcharakter aussehen?"
    elif "app" in combined or "produkt" in combined or "feature" in combined or "user" in combined:
        question = "Wer ist der Hauptnutzer dieser Idee?"
    elif "geschichte" in combined or "story" in combined or "roman" in combined:
        question = "Welche Figur trägt die Geschichte nach vorn?"
    elif note_type == "To-Do":
        question = "Was wäre der kleinste nächste Schritt?"
    else:
        question = "Welche eine Frage macht diese Idee jetzt konkreter?"

    return {
        "noteId": str(note.get("id", "")),
        "noteTitle": note_title,
        "context": _note_inspiration_context(note),
        "question": question,
    }


def interpret_text_note(api_key: str, model: str, text: str, prompt_prefix: str) -> dict[str, Any]:
    clean_key = api_key.strip()
    clean_text = _clean_text(text)
    if not clean_key:
        return infer_local_summary(clean_text)
    if not clean_text:
        raise ValueError("Text ist leer")

    payload = {
        "model": model.strip() or "gpt-4o-mini",
        "input": _summary_prompt_from_prefix(prompt_prefix, "Transkript", clean_text),
    }
    log_entry = _make_llm_log_entry("Zusammenfassung", payload["model"], _normalize_messages(payload["input"]))
    try:
        response = _openai_responses(clean_key, payload)
        raw = _extract_output_text(response)
        result = _extract_summary_payload(raw, clean_text)
        log_entry["response"] = _format_summary_log(result["summaryHeadline"], result["summary"])
        _emit_llm_log(log_entry)
        return result
    except Exception:
        log_entry["error"] = "Konnte Zusammenfassung nicht abrufen; lokale Fallback-Zusammenfassung verwendet."
        _emit_llm_log(log_entry)
        return infer_local_summary(clean_text)


def classify_note_category(
    api_key: str,
    model: str,
    prompt_prefix: str,
    summary_text: str,
) -> str:
    clean_key = api_key.strip()
    clean_summary = _clean_text(summary_text)
    clean_prefix = _clean_text(prompt_prefix) or DEFAULT_CATEGORY_PROMPT_PREFIX
    if not clean_key or not clean_summary:
        return ""

    payload = {
        "model": model.strip() or "gpt-4o-mini",
        "input": [
            {
                "role": "system",
                "content": (
                    "Du klassifizierst eine deutsche BrainSession-Notiz in genau eine von drei Kategorien: Idee, To-Do oder Notiz. "
                    "Antworte nur als JSON mit category. "
                    "Nutze die vorgegebene Anleitung und den anschliessenden Notiztext. "
                    "Wenn etwas erkennbar geplant, vorgeschlagen oder konzeptionell ist, waehle Idee. "
                    "Wenn es eine konkrete Aufgabe, ein naechster Schritt oder ein To-Do ist, waehle To-Do. "
                    "Wenn weder Idee noch To-Do passt, waehle Notiz."
                ),
            },
            {
                "role": "user",
                "content": f"{clean_prefix}\n\nText der Notiz (Zusammenfassung):\n{clean_summary}",
            },
        ],
        "text": {"format": {"type": "json_schema", "name": "note_category", "schema": _build_category_schema()}},
    }
    log_entry = _make_llm_log_entry("Kategorie", payload["model"], _normalize_messages(payload["input"]))
    try:
        response = _openai_responses(clean_key, payload)
        raw = _extract_output_text(response)
        parsed = json.loads(raw)
        result = _normalize_category(parsed.get("category"))
        log_entry["response"] = _format_category_log(result)
        _emit_llm_log(log_entry)
        return result
    except Exception:
        log_entry["error"] = "Konnte Kategorie nicht klassifizieren."
        _emit_llm_log(log_entry)
        return ""


def group_notes_by_theme(
    api_key: str,
    model: str,
    prompt_prefix: str,
    notes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    clean_key = api_key.strip()
    clean_prefix = _clean_text(prompt_prefix) or DEFAULT_GROUP_PROMPT_PREFIX
    payload_notes = [_compact_note_group_payload(note) for note in notes if _clean_text(str(note.get("id", "")))]
    if not payload_notes:
        return []
    if not clean_key:
        raise ValueError("OpenAI API key fehlt")

    payload = {
        "model": model.strip() or "gpt-4o-mini",
        "input": [
            {
                "role": "system",
                "content": (
                    "Du gruppierst BrainSession-Notizen auf einem Board. "
                    "Analysiere alle Notizen als Gesamtheit und ordne sie thematisch in wenige klare Spalten. "
                    "Eine Gruppe darf Notizen, To-Dos und Ideen gemeinsam enthalten. "
                    "Erstelle nur Gruppen mit mindestens zwei Notizen; einzelne Notizen gehören nicht in eine eigene Gruppe. "
                    "Jede Notiz muss genau einer Gruppe zugeordnet werden. "
                    "Gib pro Gruppe einen kurzen Titel und eine kurze Beschreibung. "
                    "Antworte nur als JSON mit groups."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Gruppen-Prompt:\n{clean_prefix}\n\n"
                    f"Notizen als JSON:\n{json.dumps(payload_notes, ensure_ascii=False)}"
                ),
            },
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "board_groups",
                "schema": _build_group_schema(),
            }
        },
    }
    log_entry = _make_llm_log_entry("Gruppierung", payload["model"], _normalize_messages(payload["input"]))
    try:
        response = _openai_responses(clean_key, payload)
        raw = _extract_output_text(response)
        parsed = json.loads(raw)
        raw_groups = parsed.get("groups")
        if not isinstance(raw_groups, list):
            raise ValueError("No groups returned")

        groups: list[dict[str, Any]] = []
        for group in raw_groups:
            if not isinstance(group, dict):
                continue
            title = _clean_text(str(group.get("title", "")))
            description = _clean_text(str(group.get("description", "")))
            note_ids = _normalize_list(group.get("noteIds", []))
            if not title or len(note_ids) < 2:
                continue
            groups.append({"title": title, "description": description, "noteIds": note_ids})

        if not groups:
            raise ValueError("No valid groups returned")

        log_entry["response"] = _format_group_log(groups)
        _emit_llm_log(log_entry)
        return groups
    except Exception:
        log_entry["error"] = "Konnte Notizen nicht gruppieren."
        _emit_llm_log(log_entry)
        raise


def summarize_note_timeline(
    api_key: str,
    model: str,
    note_title: str,
    entry_transcripts: list[str],
    prompt_prefix: str,
) -> dict[str, Any]:
    clean_key = api_key.strip()
    entries = [f"Teilnotiz {index + 1}: {_clean_text(text)}" for index, text in enumerate(entry_transcripts) if _clean_text(text)]
    if not entries:
        raise ValueError("Keine Eintraege fuer die Zusammenfassung vorhanden")
    if not clean_key:
        joined = " ".join(entries)
        return {
            "summaryHeadline": _shorten_headline(note_title or joined),
            "summary": joined[:600] if len(joined) <= 600 else f"{joined[:597].rstrip()}...",
        }

    payload = {
        "model": model.strip() or "gpt-4o",
        "input": _summary_prompt_from_prefix(prompt_prefix, "Transkriptverlauf", f"Notiztitel: {_clean_text(note_title) or 'Neue Notiz'}\n\nVerlauf:\n" + "\n\n".join(entries)),
    }
    log_entry = _make_llm_log_entry("Zusammenfassung", payload["model"], _normalize_messages(payload["input"]), note_title=note_title)
    try:
        response = _openai_responses(clean_key, payload)
        raw = _extract_output_text(response)
        result = _extract_summary_payload(raw, " ".join(entries))
        log_entry["response"] = _format_summary_log(result["summaryHeadline"], result["summary"])
        _emit_llm_log(log_entry)
        return result
    except Exception:
        joined = " ".join(entries)
        fallback = {
            "summaryHeadline": _shorten_headline(note_title or joined),
            "summary": entries[-1] if entries else joined,
        }
        log_entry["error"] = "Konnte Verlauf nicht zusammenfassen; lokaler Fallback verwendet."
        log_entry["response"] = _format_summary_log(fallback["summaryHeadline"], fallback["summary"])
        _emit_llm_log(log_entry)
        return fallback


def generate_follow_up_question(
    api_key: str,
    model: str,
    note_title: str,
    note_summary: str,
    existing_questions: list[str],
    dismissed_question: str,
    dismissed_reason: str,
    excluded_questions: list[str] | None = None,
) -> str:
    clean_key = api_key.strip()
    if not clean_key:
        return ""
    excluded_questions = excluded_questions or []
    payload = {
        "model": model.strip() or "gpt-4o-mini",
        "input": [
            {
                "role": "system",
                "content": (
                    "Du hilfst einer Notiz mit genau einer neuen Folgefrage weiter. "
                    "Formuliere auf Deutsch eine kurze, konkrete, hilfreiche Frage. "
                    "Wiederhole keine bereits vorhandene Frage und keine Frage aus der Ausschlussliste. "
                    "Antworte nur als JSON mit dem Feld question."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Notiztitel: {_clean_text(note_title)}\n"
                    f"Zusammenfassung: {_clean_text(note_summary)}\n"
                    f"Vorhandene Fragen: {json.dumps(existing_questions, ensure_ascii=False)}\n"
                    f"Ausgeschlossene Fragen: {json.dumps(excluded_questions, ensure_ascii=False)}\n"
                    f"Zuletzt markiert: {dismissed_reason}: {_clean_text(dismissed_question)}"
                ),
            },
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "follow_up_question",
                "schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {"question": {"type": "string"}},
                    "required": ["question"],
                },
            }
        },
    }
    log_entry = _make_llm_log_entry("Folgefrage", payload["model"], _normalize_messages(payload["input"]), note_title=note_title)
    try:
        response = _openai_responses(clean_key, payload)
        raw = _extract_output_text(response)
        parsed = json.loads(raw)
        question = _clean_text(str(parsed.get("question", "")))
        log_entry["response"] = _format_question_log(question)
        normalized_existing = {normalize_question_key(item) for item in existing_questions}
        normalized_excluded = {normalize_question_key(item) for item in excluded_questions + [dismissed_question]}
        if not question:
            log_entry["error"] = "Die KI hat keine Folgefrage geliefert."
            _emit_llm_log(log_entry)
            return ""
        if normalize_question_key(question) in normalized_existing | normalized_excluded:
            log_entry["error"] = "Die KI hat eine bereits bekannte oder ausgeschlossene Frage vorgeschlagen."
            _emit_llm_log(log_entry)
            return ""
        _emit_llm_log(log_entry)
        return question
    except Exception:
        log_entry["error"] = "Konnte keine Folgefrage erzeugen."
        _emit_llm_log(log_entry)
        return ""


def generate_inspiration_suggestion(
    api_key: str,
    model: str,
    notes: list[dict[str, Any]],
) -> dict[str, str]:
    clean_key = api_key.strip()
    payload_notes = [_compact_inspiration_payload(note) for note in notes if _clean_text(str(note.get("id", "")))]
    if not payload_notes:
        return infer_local_inspiration(None, notes)
    if not clean_key:
        return infer_local_inspiration(random.choice(payload_notes), notes)

    selected_note = random.choice(payload_notes)

    payload = {
        "model": model.strip() or "gpt-4o-mini",
        "input": [
            {
                "role": "system",
                "content": (
                    "Du hilfst beim freien Weiterdenken an genau EINER BrainSession-Notiz. "
                    "Lies die Notiz wie einen Wikipedia-Einstieg: konkret, anschlussfähig und direkt weiterführend. "
                    "Formuliere einen sehr kurzen Kontextsatz und eine einzige, sehr konkrete Folgefrage. "
                    "Die Frage soll so klingen, als würde man auf der Idee aufbauen und direkt tiefer einsteigen. "
                    "Wenn es sich um eine Story-Idee handelt, frage z.B. nach Figur, Hauptcharakter, Konflikt oder Welt. "
                    "Wenn es sich um eine App- oder Produktidee handelt, frage z.B. nach Hauptnutzer, Kernproblem oder erstem Use Case. "
                    "Antworte nur als JSON mit noteId, noteTitle, context und question."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Inspiration-Prompt: {DEFAULT_INSPIRATION_PROMPT_PREFIX}\n\n"
                    f"Zufällig ausgewählte Notiz als JSON:\n{json.dumps(selected_note, ensure_ascii=False)}"
                ),
            },
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "inspiration_suggestion",
                "schema": _build_inspiration_schema(),
            }
        },
    }
    log_entry = _make_llm_log_entry("Inspiration", payload["model"], _normalize_messages(payload["input"]))
    try:
        response = _openai_responses(clean_key, payload)
        raw = _extract_output_text(response)
        parsed = json.loads(raw)
        note_id = _clean_text(str(parsed.get("noteId", selected_note["id"])))
        note_title = _clean_text(str(parsed.get("noteTitle", selected_note["title"])))
        context = _clean_text(str(parsed.get("context", "")))
        question = _clean_text(str(parsed.get("question", "")))
        if not context or not question:
            raise ValueError("Incomplete inspiration payload")
        log_entry["response"] = _format_inspiration_log(context, question)
        _emit_llm_log(log_entry)
        return {"noteId": note_id, "noteTitle": note_title, "context": context, "question": question}
    except Exception:
        log_entry["error"] = "Konnte keine Inspiration erzeugen; lokaler Fallback verwendet."
        fallback = infer_local_inspiration(selected_note, notes)
        log_entry["response"] = _format_inspiration_log(fallback["context"], fallback["question"])
        _emit_llm_log(log_entry)
        return fallback


def generate_chat_response(
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    relevant_notes: list[dict[str, Any]],
    *,
    speech_mode: bool = False,
) -> dict[str, Any]:
    clean_key = api_key.strip()
    normalized_messages = _normalize_messages(messages)
    if not clean_key:
        raise ValueError("OpenAI API key fehlt")

    note_payload = [_chat_note_payload(note) for note in relevant_notes if _clean_text(str(note.get("id", "")))]
    conversation_blob = _chat_message_blob(normalized_messages)
    payload = {
        "model": model.strip() or "gpt-5.4-nano",
        "input": [
            {
                "role": "system",
                "content": (
                    _chat_system_prompt(speech_mode=speech_mode)
                    + " "
                    "Wenn du dich auf konkrete Notizen beziehst, gib ihre IDs und eine kurze Begründung in references aus. "
                    "Antworte nur als JSON mit reply, references und actions."
                ),
            },
            {
                "role": "system",
                "content": (
                    f"Verfuegbare Notizen als Kontext:\n{json.dumps(note_payload, ensure_ascii=False, indent=2)}\n\n"
                    f"Konversationsverlauf:\n{conversation_blob or '(leer)'}"
                ),
            },
            *normalized_messages,
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "brainsession_chat_reply",
                "schema": _build_chat_schema(),
            }
        },
    }
    log_entry = _make_llm_log_entry("Chat", payload["model"], _normalize_messages(payload["input"]))
    try:
        response = _openai_responses(clean_key, payload)
        raw = _extract_output_text(response)
        parsed = json.loads(raw)
        reply = _clean_text(str(parsed.get("reply", "")))
        references_raw = parsed.get("references") if isinstance(parsed, dict) else []
        references: list[dict[str, Any]] = []
        if isinstance(references_raw, list):
            for reference in references_raw:
                if not isinstance(reference, dict):
                    continue
                note_id = _clean_text(str(reference.get("noteId", "")))
                if not note_id:
                    continue
                references.append(
                    {
                        "noteId": note_id,
                        "noteTitle": _clean_text(str(reference.get("noteTitle", ""))),
                        "reason": _clean_text(str(reference.get("reason", ""))),
                    }
                )
        if not references:
            references = [
                {
                    "noteId": _clean_text(str(note.get("id", ""))),
                    "noteTitle": _clean_text(str(note.get("title", ""))) or "Neue Notiz",
                    "reason": "relevanter Kontext",
                }
                for note in relevant_notes[:3]
                if _clean_text(str(note.get("id", "")))
            ]
        actions_raw = parsed.get("actions") if isinstance(parsed, dict) else []
        actions: list[dict[str, Any]] = []
        if isinstance(actions_raw, list):
            for action in actions_raw:
                if not isinstance(action, dict):
                    continue
                action_type = _clean_text(str(action.get("type", ""))).lower()
                if action_type not in {"create_note", "create_group"}:
                    continue
                actions.append(
                    {
                        "type": action_type,
                        "text": _clean_text(str(action.get("text", ""))),
                        "title": _clean_text(str(action.get("title", ""))),
                        "description": _clean_text(str(action.get("description", ""))),
                        "noteIds": _normalize_list(action.get("noteIds", [])),
                    }
                )

        if not reply:
            raise ValueError("Leere Chat-Antwort")

        log_entry["response"] = _format_question_log(reply)
        _emit_llm_log(log_entry)
        return {"reply": reply, "references": references, "actions": actions}
    except Exception:
        log_entry["error"] = "Konnte keine Chat-Antwort erzeugen."
        _emit_llm_log(log_entry)
        return {
            "reply": "Ich kann gerade nicht mit der OpenAI API sprechen. Bitte prüfe den API-Key oder versuche es gleich noch einmal.",
            "references": [],
            "actions": [],
        }


def transcribe_audio(
    api_key: str,
    audio_path: Path,
    model: str,
    language: str = "de",
    prompt: str = "",
) -> str:
    if not api_key.strip():
        raise ValueError("OpenAI API key fehlt")
    log_entry = _make_llm_log_entry(
        "Transkription",
        model.strip() or "whisper-1",
        [
            {"role": "system", "content": _clean_text(prompt) or DEFAULT_TRANSCRIPTION_PROMPT},
            {
                "role": "user",
                "content": f"Datei: {audio_path.name}\nSprache: {language.strip() or 'de'}",
            },
        ],
    )
    try:
        transcript = _openai_transcribe(api_key, audio_path, model=model, language=language, prompt=prompt)
        if not _clean_text(transcript):
            raise RuntimeError("OpenAI Whisper hat kein Transkript geliefert")
        log_entry["response"] = _format_transcription_log(transcript)
        if _is_suspicious_transcript(transcript):
            log_entry["warning"] = "Transkript wirkt wiederholt, wurde aber trotzdem übernommen."
        _emit_llm_log(log_entry)
        return transcript
    except Exception:
        log_entry["error"] = "Konnte Audio nicht transkribieren."
        _emit_llm_log(log_entry)
        raise


def infer_tags(text: str) -> list[str]:
    words = [word.lower() for word in re.findall(r"[A-Za-zÄÖÜäöüß0-9]{3,}", text or "")]
    counts = Counter(word for word in words if word not in STOP_WORDS)
    return [word for word, _ in counts.most_common(4)]


def normalize_question_key(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip()).lower()


def _normalize_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        text = _clean_text(str(item))
        if text:
            result.append(text)
    return result


def _normalize_tags(value: Any) -> list[str]:
    tags = _normalize_list(value)
    return tags[:6]


def _filter_questions(questions: list[str], excluded_questions: list[str]) -> list[str]:
    excluded = {normalize_question_key(item) for item in excluded_questions}
    seen: set[str] = set()
    result: list[str] = []
    for question in questions:
        key = normalize_question_key(question)
        if not question or key in seen or key in excluded:
            continue
        seen.add(key)
        result.append(question)
    return result[:5]


def _merge_todo_states(current_todos: list[str], current_states: list[bool], todos: list[str]) -> list[bool]:
    state_map = {normalize_question_key(todo): bool(current_states[index]) for index, todo in enumerate(current_todos) if index < len(current_states)}
    return [state_map.get(normalize_question_key(todo), False) for todo in todos]
