export type TabKey = 'capture' | 'chat' | 'inbox' | 'inspiration' | 'board'

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
  chatModel: string
  language: string
  transcriptionPrompt: string
  summaryPromptPrefix: string
  categoryPromptPrefix: string
  groupPromptPrefix: string
  dataDir: string
  mediaDir: string
}

export interface BoardGroup {
  key: string
  title: string
  description: string
  source: 'auto' | 'manual'
  notes: NoteNode[]
}

export interface BoardGroupDraft {
  key: string
  title: string
  description: string
  source: 'auto' | 'manual'
  noteIds: string[]
}

export interface BoardGroupsResponse {
  groups: BoardGroup[]
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

export interface InspirationResponse {
  noteId: string
  noteTitle: string
  context: string
  question: string
}

export interface LlmLogMessage {
  role: 'system' | 'user' | 'assistant' | 'meta'
  content: string
}

export interface LlmLogEntry {
  id: string
  createdAt: string
  provider: string
  kind: string
  model: string
  noteTitle: string
  messages: LlmLogMessage[]
  response: string
  error: string
}

export interface LlmLogsResponse {
  logs: LlmLogEntry[]
}

export interface RoutineResponse {
  ok: boolean
  updatedNotes: number
  skippedNotes: number
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatAction {
  type: 'create_note' | 'create_group'
  text: string
  title: string
  description: string
  noteIds: string[]
}

export interface ChatReference {
  noteId: string
  noteTitle: string
  reason: string
}

export interface ChatRequest {
  messages: ChatMessage[]
}

export interface ChatResponse {
  reply: string
  actions: ChatAction[]
  references: ChatReference[]
  transcript: string
  inputAudioRelativePath: string
  replyAudioRelativePath: string
}
