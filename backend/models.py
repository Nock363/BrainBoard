from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class NoteTimelineEntry(BaseModel):
    id: str
    kind: Literal["voice", "text"]
    transcript: str
    audioRelativePath: str = ""
    transcriptionState: str = ""
    transcriptionError: str = ""
    createdAt: str
    updatedAt: str


class NoteNode(BaseModel):
    id: str
    title: str
    summaryHeadline: str = ""
    summary: str
    rawTranscript: str
    category: str = ""
    audioRelativePath: str = ""
    entries: list[NoteTimelineEntry] = Field(default_factory=list)
    createdAt: str
    updatedAt: str


class SettingsResponse(BaseModel):
    openAiApiKeyPresent: bool
    openAiModel: str
    transcriptionModel: str
    summaryModel: str
    followUpModel: str
    language: str
    transcriptionPrompt: str
    summaryPromptPrefix: str
    categoryPromptPrefix: str
    groupPromptPrefix: str
    dataDir: str
    mediaDir: str


class UpdateSettingsRequest(BaseModel):
    openAiApiKey: str | None = None
    openAiModel: str | None = None
    transcriptionModel: str | None = None
    summaryModel: str | None = None
    followUpModel: str | None = None
    language: str | None = None
    transcriptionPrompt: str | None = None
    summaryPromptPrefix: str | None = None
    categoryPromptPrefix: str | None = None
    groupPromptPrefix: str | None = None


class CreateTextNoteRequest(BaseModel):
    text: str = Field(min_length=1)


class AppendTextRequest(BaseModel):
    text: str = Field(min_length=1)


class DismissFollowUpRequest(BaseModel):
    reason: Literal["schon beantwortet", "unwichtig"]


class ToggleTodoRequest(BaseModel):
    checked: bool


class UpdateNoteCategoryRequest(BaseModel):
    category: Literal["", "Idea", "Task"]


class UpdateNoteTranscriptRequest(BaseModel):
    transcript: str = Field(min_length=1)


class CreateVoiceNoteResponse(BaseModel):
    note: NoteNode


class NotesResponse(BaseModel):
    notes: list[NoteNode]


class NoteResponse(BaseModel):
    note: NoteNode


class ReportResponse(BaseModel):
    ok: bool
    reportMarkdown: str
    fileName: str


class InspirationResponse(BaseModel):
    noteId: str
    noteTitle: str
    context: str
    question: str


class BoardGroupItem(BaseModel):
    key: str
    title: str
    description: str = ""
    source: Literal["auto", "manual"] = "auto"
    notes: list[NoteNode] = Field(default_factory=list)


class BoardGroupsResponse(BaseModel):
    groups: list[BoardGroupItem] = Field(default_factory=list)


class BoardGroupDraft(BaseModel):
    key: str
    title: str
    description: str = ""
    source: Literal["auto", "manual"] = "manual"
    noteIds: list[str] = Field(default_factory=list)


class BoardGroupsSaveRequest(BaseModel):
    groups: list[BoardGroupDraft] = Field(default_factory=list)


class LlmLogMessage(BaseModel):
    role: Literal["system", "user", "assistant", "meta"]
    content: str


class LlmLogEntry(BaseModel):
    id: str
    createdAt: str
    provider: str
    kind: str
    model: str
    noteTitle: str = ""
    messages: list[LlmLogMessage] = Field(default_factory=list)
    response: str = ""
    error: str = ""


class LlmLogsResponse(BaseModel):
    logs: list[LlmLogEntry]


class RoutineResponse(BaseModel):
    ok: bool
    updatedNotes: int
    skippedNotes: int = 0
