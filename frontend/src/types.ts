export type TabKey = 'capture' | 'live' | 'notes' | 'settings'

export interface NoteSummarySections {
  todos: string[]
  todoStates: boolean[]
  milestones: string[]
  questions: string[]
}

export interface FollowUpQuestionReview {
  question: string
  reason: string
  createdAt: string
}

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
  summary: string
  rawTranscript: string
  bullets: string[]
  tags: string[]
  summarySections: NoteSummarySections
  followUpQuestionReviews: FollowUpQuestionReview[]
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
