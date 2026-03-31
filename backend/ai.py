from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

import requests


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
    "suggestion": "Idea",
    "task": "Task",
    "to-do": "Task",
    "todo": "Task",
    "aufgabe": "Task",
}


def _clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def _normalize_category(value: Any) -> str:
    text = _clean_text(str(value or "")).lower()
    if not text:
        return ""
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


def _infer_category_from_text(text: str) -> str:
    lowered = _clean_text(text).lower()
    if not lowered:
        return ""
    if re.search(r"\b(todo|aufgabe|erledigen|machen|soll|muss|bitte|deadline|termin)\b", lowered):
        return "Task"
    if re.search(r"\b(idee|brainstorm|konzept|vorschlag|skizze|inspiriert|würde|wuerde)\b", lowered):
        return "Idea"
    return ""


def infer_local_summary(text: str) -> dict[str, Any]:
    clean = _clean_text(text)
    if not clean:
        return {
            "summaryHeadline": "Neue Notiz",
            "summary": "",
        }

    sentences = re.split(r"(?<=[.!?])\s+", clean)
    headline = sentences[0] if sentences else clean
    headline = headline[:72].strip().rstrip(".,;:") or "Neue Notiz"
    summary = clean if len(clean) <= 220 else f"{clean[:217].rstrip()}..."

    return {
        "summaryHeadline": headline,
        "summary": summary,
    }


def infer_local_category(text: str) -> str:
    return _infer_category_from_text(text)


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
        timeout=180,
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


def infer_local_interpretation(text: str) -> dict[str, Any]:
    summary = infer_local_summary(text)
    summary["category"] = infer_local_category(text)
    return summary


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


def interpret_text_note(api_key: str, model: str, text: str) -> dict[str, Any]:
    clean_key = api_key.strip()
    clean_text = _clean_text(text)
    if not clean_key:
        return infer_local_summary(clean_text)
    if not clean_text:
        raise ValueError("Text ist leer")

    payload = {
        "model": model.strip() or "gpt-4o-mini",
        "input": [
            {
                "role": "system",
                "content": (
                    "Du erzeugst fuer eine BrainSession-Notiz nur eine kurze deutschsprachige Zusammenfassung. "
                    "Antworte nur als JSON mit summaryHeadline und summary. "
                    "summaryHeadline soll maximal fuenf Woerter haben und catchy klingen. "
                    "Die Zusammenfassung soll den gesamten Inhalt knapp und integriert wiedergeben."
                ),
            },
            {"role": "user", "content": f"Notiztext:\n{clean_text}"},
        ],
        "text": {"format": {"type": "json_schema", "name": "note_summary", "schema": _build_summary_schema()}},
    }
    try:
        response = _openai_responses(clean_key, payload)
        raw = _extract_output_text(response)
        parsed = json.loads(raw)
        fallback = infer_local_summary(clean_text)
        return {
            "summaryHeadline": _clean_text(str(parsed.get("summaryHeadline", ""))) or fallback["summaryHeadline"],
            "summary": _clean_text(str(parsed.get("summary", ""))) or fallback["summary"],
        }
    except Exception:
        return infer_local_summary(clean_text)


def classify_note_category(api_key: str, model: str, summary_text: str) -> str:
    clean_key = api_key.strip()
    clean_summary = _clean_text(summary_text)
    if not clean_summary:
        return ""
    if not clean_key:
        return infer_local_category(clean_summary)

    payload = {
        "model": model.strip() or "gpt-4o-mini",
        "input": [
            {
                "role": "system",
                "content": (
                    "Du klassifizierst eine deutsche Notiz-Zusammenfassung in genau eine von drei Kategorien: Idea, Task oder leer. "
                    "Antworte nur als JSON mit category. "
                    "category muss genau Idea oder Task sein, oder leer bleiben wenn es nicht sicher erkennbar ist."
                ),
            },
            {"role": "user", "content": f"Zusammenfassung:\n{clean_summary}"},
        ],
        "text": {"format": {"type": "json_schema", "name": "note_category", "schema": _build_category_schema()}},
    }
    try:
        response = _openai_responses(clean_key, payload)
        raw = _extract_output_text(response)
        parsed = json.loads(raw)
        return _normalize_category(parsed.get("category")) or infer_local_category(clean_summary)
    except Exception:
        return infer_local_category(clean_summary)


def summarize_note_timeline(
    api_key: str,
    model: str,
    note_title: str,
    entry_transcripts: list[str],
) -> dict[str, Any]:
    clean_key = api_key.strip()
    entries = [f"Teilnotiz {index + 1}: {_clean_text(text)}" for index, text in enumerate(entry_transcripts) if _clean_text(text)]
    if not entries:
        raise ValueError("Keine Eintraege fuer die Zusammenfassung vorhanden")
    if not clean_key:
        joined = " ".join(entries)
        return {
            "summaryHeadline": _clean_text(note_title)[:72] or "Neue Notiz",
            "summary": joined[:600] if len(joined) <= 600 else f"{joined[:597].rstrip()}...",
        }

    payload = {
        "model": model.strip() or "gpt-4o",
        "input": [
            {
                "role": "system",
                "content": (
                    "Du erstellst eine strukturierte deutsche Zusammenfassung einer fortlaufenden Notiz. "
                    "Fruehere Aussagen koennen spaeter ergaenzt oder korrigiert werden. "
                    "Die spaeteren Angaben haben Vorrang, wenn sie im Verlauf eine fruehere Aussage revidieren. "
                    "Die Ausgabe muss JSON sein mit summaryHeadline und summary. "
                    "summaryHeadline soll maximal fuenf Woerter haben und die gesamte Notiz knapp benennen. "
                    "Formuliere die Zusammenfassung integriert, nicht als einfache Listenfolge."
                ),
            },
            {"role": "user", "content": f"Notiztitel: {_clean_text(note_title) or 'Neue Notiz'}\n\nVerlauf:\n" + "\n\n".join(entries)},
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "note_timeline_summary",
                "schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "summaryHeadline": {"type": "string"},
                        "summary": {"type": "string"},
                    },
                    "required": ["summaryHeadline", "summary"],
                },
            }
        },
    }
    try:
        response = _openai_responses(clean_key, payload)
        raw = _extract_output_text(response)
        parsed = json.loads(raw)
        summary = _clean_text(str(parsed.get("summary", "")))
        if not summary:
            raise ValueError("No summary returned")
        summary_headline = _clean_text(str(parsed.get("summaryHeadline", "")))
        return {
            "summaryHeadline": summary_headline,
            "summary": summary,
        }
    except Exception:
        joined = " ".join(entries)
        return {
            "summaryHeadline": _clean_text(note_title)[:72] or "Neue Notiz",
            "summary": entries[-1] if entries else joined,
        }


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
    try:
        response = _openai_responses(clean_key, payload)
        raw = _extract_output_text(response)
        parsed = json.loads(raw)
        question = _clean_text(str(parsed.get("question", "")))
        if not question:
            return ""
        normalized_existing = {normalize_question_key(item) for item in existing_questions}
        normalized_excluded = {normalize_question_key(item) for item in excluded_questions + [dismissed_question]}
        if normalize_question_key(question) in normalized_existing | normalized_excluded:
            return ""
        return question
    except Exception:
        return ""


def transcribe_audio(
    api_key: str,
    audio_path: Path,
    model: str,
    language: str = "de",
    prompt: str = "",
) -> str:
    if not api_key.strip():
        raise ValueError("OpenAI API key fehlt")
    return _openai_transcribe(api_key, audio_path, model=model, language=language, prompt=prompt)


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
