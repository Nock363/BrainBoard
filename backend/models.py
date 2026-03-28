from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class NoteSummarySections(BaseModel):
    todos: list[str] = Field(default_factory=list)
    todoStates: list[bool] = Field(default_factory=list)
    milestones: list[str] = Field(default_factory=list)
    questions: list[str] = Field(default_factory=list)


class FollowUpQuestionReview(BaseModel):
    question: str
    reason: str
    createdAt: str


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
    summary: str
    rawTranscript: str
    bullets: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    summarySections: NoteSummarySections = Field(default_factory=NoteSummarySections)
    followUpQuestionReviews: list[FollowUpQuestionReview] = Field(default_factory=list)
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
    dataDir: str
    mediaDir: str


class UpdateSettingsRequest(BaseModel):
    openAiApiKey: str | None = None
    openAiModel: str | None = None
    transcriptionModel: str | None = None
    summaryModel: str | None = None
    followUpModel: str | None = None
    language: str | None = None


class CreateTextNoteRequest(BaseModel):
    text: str = Field(min_length=1)


class AppendTextRequest(BaseModel):
    text: str = Field(min_length=1)


class DismissFollowUpRequest(BaseModel):
    reason: Literal["schon beantwortet", "unwichtig"]


class ToggleTodoRequest(BaseModel):
    checked: bool


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

