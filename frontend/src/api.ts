import type {
  LlmLogsResponse,
  NoteResponse,
  NotesResponse,
  ReportResponse,
  RoutineResponse,
  SettingsResponse,
} from './types'

const API_PREFIX = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? ''

function url(path: string): string {
  return `${API_PREFIX}${path}`
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url(path), {
    headers: {
      Accept: 'application/json',
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
    ...init,
  })

  if (!response.ok) {
    const fallback = `${response.status} ${response.statusText}`
    let detail = fallback
    try {
      const body = await response.json()
      if (typeof body?.detail === 'string' && body.detail.trim()) {
        detail = body.detail
      }
    } catch {
      // fall back to the HTTP status text
    }
    throw new Error(detail)
  }

  return (await response.json()) as T
}

export const api = {
  async health(): Promise<{ ok: boolean }> {
    return requestJson('/api/health')
  },
  async loadSettings(): Promise<SettingsResponse> {
    return requestJson('/api/settings')
  },
  async loadLlmLogs(limit = 100): Promise<LlmLogsResponse> {
    return requestJson(`/api/llm-logs?limit=${encodeURIComponent(String(limit))}`)
  },
  async saveSettings(payload: {
    openAiApiKey?: string
    openAiModel?: string
    transcriptionModel?: string
    summaryModel?: string
    followUpModel?: string
    language?: string
    categoryPromptPrefix?: string
  }): Promise<SettingsResponse> {
    return requestJson('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
  },
  async listNotes(): Promise<NotesResponse> {
    return requestJson('/api/notes')
  },
  async getNote(noteId: string): Promise<NoteResponse> {
    return requestJson(`/api/notes/${encodeURIComponent(noteId)}`)
  },
  async createTextNote(text: string): Promise<NoteResponse> {
    return requestJson('/api/notes/text', {
      method: 'POST',
      body: JSON.stringify({ text }),
    })
  },
  async createVoiceNote(blob: Blob, mimeType: string, noteId?: string): Promise<NoteResponse> {
    const form = new FormData()
    const extension = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('webm') ? 'webm' : mimeType.includes('wav') ? 'wav' : 'dat'
    form.append('audio', new File([blob], `recording.${extension}`, { type: mimeType || blob.type || 'audio/webm' }))
    if (noteId) {
      form.append('noteId', noteId)
    }
    return requestJson('/api/notes/voice', {
      method: 'POST',
      body: form,
    })
  },
  async appendText(noteId: string, text: string): Promise<NoteResponse> {
    return requestJson(`/api/notes/${encodeURIComponent(noteId)}/entries/text`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    })
  },
  async regenerateSummary(noteId: string): Promise<NoteResponse> {
    return requestJson(`/api/notes/${encodeURIComponent(noteId)}/regenerate-summary`, {
      method: 'POST',
      body: '{}',
    })
  },
  async analyzeNote(noteId: string): Promise<NoteResponse> {
    return requestJson(`/api/notes/${encodeURIComponent(noteId)}/analyze`, {
      method: 'POST',
      body: '{}',
    })
  },
  async updateNoteCategory(noteId: string, category: '' | 'Idea' | 'Task'): Promise<NoteResponse> {
    return requestJson(`/api/notes/${encodeURIComponent(noteId)}/category`, {
      method: 'PUT',
      body: JSON.stringify({ category }),
    })
  },
  async reanalyzeAllNotes(): Promise<RoutineResponse> {
    return requestJson('/api/routines/reanalyze-notes', {
      method: 'POST',
      body: '{}',
    })
  },
  async toggleTodo(noteId: string, todoIndex: number, checked: boolean): Promise<NoteResponse> {
    return requestJson(`/api/notes/${encodeURIComponent(noteId)}/todos/${todoIndex}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ checked }),
    })
  },
  async dismissQuestion(noteId: string, questionIndex: number, reason: 'schon beantwortet' | 'unwichtig'): Promise<NoteResponse> {
    return requestJson(`/api/notes/${encodeURIComponent(noteId)}/follow-up/${questionIndex}/dismiss`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    })
  },
  async retryTranscription(noteId: string, entryId: string): Promise<NoteResponse> {
    return requestJson(`/api/notes/${encodeURIComponent(noteId)}/entries/${encodeURIComponent(entryId)}/retry`, {
      method: 'POST',
      body: '{}',
    })
  },
  async deleteNote(noteId: string): Promise<void> {
    await requestJson(`/api/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' })
  },
  async deleteAllNotes(): Promise<void> {
    await requestJson('/api/notes', { method: 'DELETE' })
  },
  async exportTechnicalReport(): Promise<ReportResponse> {
    return requestJson('/api/reports/technical')
  },
}

export function mediaUrl(relativePath: string): string {
  const clean = relativePath.replace(/^\/+/, '')
  return url(`/media/${clean}`)
}
