export type TabKey = 'capture' | 'inbox' | 'board'

export type NoteCategory = '' | 'Idea' | 'Task'

export interface NoteTimelineEntry {
  id: string
  kind: 'voice' | 'text'
  transcript: string
  audioRelativePath: string
  transcriptionState: string
  transcriptionError: string
  createdAt: string
  updatedAt: string
}

export interface NoteNode {
  id: string
  title: string
  summaryHeadline: string
  summary: string
  rawTranscript: string
  category: NoteCategory
  audioRelativePath: string
  entries: NoteTimelineEntry[]
  createdAt: string
  updatedAt: string
}

export interface SettingsResponse {
  openAiApiKeyPresent: boolean
  openAiModel: string
  transcriptionModel: string
  summaryModel: string
  followUpModel: string
  language: string
  dataDir: string
  mediaDir: string
}

export interface NotesResponse {
  notes: NoteNode[]
}

export interface NoteResponse {
  note: NoteNode
}

export interface ReportResponse {
  ok: boolean
  reportMarkdown: string
  fileName: string
}

export interface RoutineResponse {
  ok: boolean
  updatedNotes: number
  skippedNotes: number
}
