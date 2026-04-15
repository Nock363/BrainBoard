import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { api, mediaUrl } from './api'
import { useVoiceRecorder } from './hooks/useVoiceRecorder'
import type { BoardGroup, BoardGroupDraft, LlmLogEntry, NoteCategory, NoteNode, SettingsResponse, TabKey } from './types'

type BusyState = { message: string } | null

type InspirationSuggestion = {
  noteId: string
  noteTitle: string
  context: string
  question: string
}

type AppHistoryState = {
  tab: TabKey
  selectedNoteId: string
}

type SettingsDraft = {
  openAiApiKey: string
  openAiModel: string
  transcriptionModel: string
  summaryModel: string
  followUpModel: string
  language: string
  transcriptionPrompt: string
  summaryPromptPrefix: string
  categoryPromptPrefix: string
  groupPromptPrefix: string
}

type GroupToken = {
  key: string
  label: string
}

type PreparedNoteGroup = {
  note: NoteNode
  tokens: GroupToken[]
  signature: Set<string>
  weightSum: number
}

type BoardGroupEditorDraft = BoardGroupDraft

function makeBoardGroupKey(): string {
  return `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

const GROUP_STOP_WORDS = new Set([
  'und',
  'oder',
  'der',
  'die',
  'das',
  'ein',
  'eine',
  'ist',
  'sind',
  'mit',
  'für',
  'fuer',
  'dass',
  'du',
  'ich',
  'wir',
  'was',
  'wie',
  'auf',
  'im',
  'in',
  'am',
  'an',
  'zu',
  'den',
  'dem',
  'des',
  'von',
  'noch',
  'aber',
  'nicht',
  'nur',
  'auch',
  'als',
  'bei',
  'the',
  'note',
  'notiz',
  'idee',
  'todo',
  'to',
  'do',
  'task',
  'aufgabe',
  'projekt',
  'planung',
  'plan',
  'termin',
  'terminen',
  'besprechung',
  'meeting',
  'brainstorming',
])

const tabs: Array<{ key: TabKey; label: string; icon: string }> = [
  { key: 'capture', label: 'Start', icon: 'bi-stars' },
  { key: 'inbox', label: 'Eingang', icon: 'bi-inbox-fill' },
  { key: 'inspiration', label: 'Ideen', icon: 'bi-lightbulb-fill' },
  { key: 'board', label: 'Board', icon: 'bi-kanban-fill' },
]

function formatRelativeDate(value: string): string {
  if (!value) {
    return ''
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function uniqueStrings(values: string[], maxItems = 6): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const clean = value.trim()
    if (!clean || seen.has(clean.toLowerCase())) {
      continue
    }
    seen.add(clean.toLowerCase())
    result.push(clean)
    if (result.length >= maxItems) {
      break
    }
  }
  return result
}

function uniqueGroupTokens(tokens: GroupToken[], maxItems = 12): GroupToken[] {
  const seen = new Set<string>()
  const result: GroupToken[] = []
  for (const token of tokens) {
    if (!token.key || seen.has(token.key)) {
      continue
    }
    seen.add(token.key)
    result.push(token)
    if (result.length >= maxItems) {
      break
    }
  }
  return result
}

function normalizeGroupToken(value: string): string {
  return value
    .toLocaleLowerCase('de-DE')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
}

function capitalizeGroupLabel(value: string): string {
  const clean = value.trim()
  if (!clean) {
    return ''
  }
  return clean.charAt(0).toLocaleUpperCase('de-DE') + clean.slice(1)
}

function tokenizeGroupText(value: string): GroupToken[] {
  const matches = value.match(/[\p{L}\p{N}]+/gu) ?? []
  const tokens: GroupToken[] = []
  for (const rawToken of matches) {
    const label = rawToken.trim().replace(/^[_-]+|[_-]+$/g, '')
    if (!label) {
      continue
    }
    const key = normalizeGroupToken(label)
    if (key.length < 3 || /^\d+$/.test(key) || GROUP_STOP_WORDS.has(key)) {
      continue
    }
    tokens.push({ key, label })
  }
  return uniqueGroupTokens(tokens, 18)
}

function extractGroupTokens(note: NoteNode): GroupToken[] {
  const sections = [noteTitle(note), safeText(note.summaryHeadline), safeText(note.summary), safeText(note.rawTranscript)]
  const tokens = sections.flatMap((section) => tokenizeGroupText(section))
  return uniqueGroupTokens(tokens, 18)
}

function buildGroupSignature(tokens: GroupToken[]): Set<string> {
  return new Set(tokens.map((token) => token.key))
}

function sharedSignatureWeight(left: Set<string>, right: Set<string>, frequency: Map<string, number>): number {
  let weight = 0
  for (const token of left) {
    if (!right.has(token)) {
      continue
    }
    weight += 1 / Math.max(1, frequency.get(token) ?? 1)
  }
  return weight
}

function signatureWeight(tokens: Set<string>, frequency: Map<string, number>): number {
  let weight = 0
  for (const token of tokens) {
    weight += 1 / Math.max(1, frequency.get(token) ?? 1)
  }
  return weight
}

function buildGroupLabel(tokens: GroupToken[], fallback: string): string {
  const firstToken = tokens[0]?.label ?? ''
  const cleanFallback = fallback.trim()
  if (firstToken.trim()) {
    return capitalizeGroupLabel(firstToken)
  }
  return cleanFallback || 'Gruppe'
}

function formatGroupKeywords(tokens: GroupToken[], maxItems = 3): string[] {
  return uniqueStrings(tokens.map((token) => capitalizeGroupLabel(token.label)).filter(Boolean), maxItems)
}

function createBoardGroups(notes: NoteNode[]): BoardGroup[] {
  const orderedNotes = [...notes].sort((left, right) => {
    const rightTime = new Date(right.updatedAt).getTime()
    const leftTime = new Date(left.updatedAt).getTime()
    return rightTime - leftTime
  })

  const prepared = orderedNotes.map((note) => {
    const tokens = extractGroupTokens(note)
    return {
      note,
      tokens,
      signature: buildGroupSignature(tokens),
      weightSum: 0,
    }
  })

  const frequency = new Map<string, number>()
  for (const item of prepared) {
    for (const token of item.signature) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1)
    }
  }

  const clusters: Array<{ notes: PreparedNoteGroup[]; signature: Set<string> }> = []
  const unassignedNotes: NoteNode[] = []

  for (const item of prepared) {
    const itemWeight = signatureWeight(item.signature, frequency)
    let bestClusterIndex = -1
    let bestScore = 0

    for (let index = 0; index < clusters.length; index += 1) {
      const cluster = clusters[index]
      const sharedWeight = sharedSignatureWeight(item.signature, cluster.signature, frequency)
      const score = sharedWeight / Math.max(0.001, itemWeight)
      if (score > bestScore) {
        bestScore = score
        bestClusterIndex = index
      }
    }

    const shouldJoinCluster = bestClusterIndex >= 0 && (bestScore >= 0.3 || (bestScore >= 0.16 && item.signature.size <= 5))

    if (!shouldJoinCluster) {
      clusters.push({ notes: [item], signature: new Set(item.signature) })
      continue
    }

    const cluster = clusters[bestClusterIndex]
    cluster.notes.push(item)
    for (const token of item.signature) {
      cluster.signature.add(token)
    }
  }

  const groupedClusters = clusters
    .map((cluster, index) => {
      const tokensByFrequency = new Map<string, { label: string; count: number; firstSeen: number }>()
      cluster.notes.forEach((item, noteIndex) => {
        for (const token of item.tokens) {
          const current = tokensByFrequency.get(token.key)
          if (current) {
            current.count += 1
          } else {
            tokensByFrequency.set(token.key, { label: token.label, count: 1, firstSeen: noteIndex })
          }
        }
      })

      const rankedTokens = [...tokensByFrequency.values()]
        .sort((left, right) => {
          if (right.count !== left.count) {
            return right.count - left.count
          }
          if (left.firstSeen !== right.firstSeen) {
            return left.firstSeen - right.firstSeen
          }
          return right.label.length - left.label.length
        })
        .map((item) => ({ key: normalizeGroupToken(item.label), label: item.label }))

      const firstNote = cluster.notes[0]?.note
      const title = buildGroupLabel(rankedTokens, firstNote ? noteTitle(firstNote) : 'Gruppe')
      const keywordTokens = formatGroupKeywords(rankedTokens)

      const groupedNotes = cluster.notes.map((item) => item.note).sort((left, right) => {
        const rightTime = new Date(right.updatedAt).getTime()
        const leftTime = new Date(left.updatedAt).getTime()
        return rightTime - leftTime
      })

      return {
        key: `group-${index}`,
        title,
        description: keywordTokens.length > 0 ? `Gemeinsame Begriffe: ${keywordTokens.join(' · ')}` : 'Thematisch ähnliche Notizen aus dem Board.',
        source: 'auto' as const,
        notes: groupedNotes,
      }
    })
    .filter((group) => {
      if (group.notes.length > 1) {
        return true
      }
      unassignedNotes.push(group.notes[0])
      return false
    })
    .sort((left, right) => {
      const leftTime = new Date(left.notes[0]?.updatedAt ?? 0).getTime()
      const rightTime = new Date(right.notes[0]?.updatedAt ?? 0).getTime()
      return rightTime - leftTime
    })

  if (unassignedNotes.length > 0) {
    groupedClusters.unshift({
      key: 'unassigned',
      title: 'Nicht zugeordnet',
      description: 'Notizen ohne klare thematische Gruppe.',
      source: 'auto' as const,
      notes: unassignedNotes,
    })
  }

  return groupedClusters
}

function safeText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function downloadMarkdown(fileName: string, markdown: string) {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1500)
}

function noteAudioPath(note: NoteNode): string {
  const entries = Array.isArray(note.entries) ? note.entries : []
  return note.audioRelativePath || entries.find((entry) => entry.audioRelativePath)?.audioRelativePath || ''
}

function noteTitle(note: NoteNode): string {
  return note.summaryHeadline || note.title || 'Neue Notiz'
}

function categoryLabel(category: NoteCategory): string {
  if (category === 'Idea') return 'Idee'
  if (category === 'Task') return 'To-Do'
  return 'Notiz'
}

function categoryThemeClass(category: NoteCategory): string {
  if (category === 'Idea') return 'sticky-note-idea'
  if (category === 'Task') return 'sticky-note-task'
  return 'sticky-note-neutral'
}

const noteCategoryOptions: Array<{
  value: NoteCategory
  label: string
  themeClass: string
}> = [
  {
    value: '',
    label: 'Notiz',
    themeClass: 'sticky-note-neutral',
  },
  {
    value: 'Idea',
    label: 'Idee',
    themeClass: 'sticky-note-idea',
  },
  {
    value: 'Task',
    label: 'To-Do',
    themeClass: 'sticky-note-task',
  },
]

function noteSummary(note: NoteNode): string {
  const summary = safeText(note.summary)
  if (summary.trim()) {
    return summary
  }
  const rawTranscript = safeText(note.rawTranscript)
  if (rawTranscript.trim()) {
    return rawTranscript
  }
  return 'Noch keine Zusammenfassung vorhanden.'
}

function isProcessingNote(note: NoteNode): boolean {
  const entries = Array.isArray(note.entries) ? note.entries : []
  return entries.some((entry) => entry.transcriptionState === 'processing')
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('capture')
  const [notes, setNotes] = useState<NoteNode[]>([])
  const [settings, setSettings] = useState<SettingsResponse | null>(null)
  const [selectedNoteId, setSelectedNoteId] = useState('')
  const [expandedInboxNoteId, setExpandedInboxNoteId] = useState('')
  const [noteDraft, setNoteDraft] = useState('')
  const [textNoteOpen, setTextNoteOpen] = useState(false)
  const [busy, setBusy] = useState<BusyState>(null)
  const [error, setError] = useState('')
  const [playingId, setPlayingId] = useState('')
  const [inspirationSuggestion, setInspirationSuggestion] = useState<InspirationSuggestion | null>(null)
  const [inspirationLoading, setInspirationLoading] = useState(false)
  const [inspirationError, setInspirationError] = useState('')
  const [deleteNoteTarget, setDeleteNoteTarget] = useState<NoteNode | null>(null)
  const [deleteAllOpen, setDeleteAllOpen] = useState(false)
  const [boardGroups, setBoardGroups] = useState<BoardGroup[]>([])
  const [boardGroupsLoading, setBoardGroupsLoading] = useState(false)
  const [boardGroupEditorOpen, setBoardGroupEditorOpen] = useState(false)
  const [boardGroupEditorDraft, setBoardGroupEditorDraft] = useState<BoardGroupEditorDraft>({
    key: '',
    title: '',
    description: '',
    source: 'manual',
    noteIds: [],
  })
  const [boardGroupEditorMode, setBoardGroupEditorMode] = useState<'create' | 'edit'>('create')
  const [boardGroupEditorError, setBoardGroupEditorError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [routineStatus, setRoutineStatus] = useState('')
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft>({
    openAiApiKey: '',
    openAiModel: '',
    transcriptionModel: '',
    summaryModel: '',
    followUpModel: '',
    language: '',
    transcriptionPrompt: '',
    summaryPromptPrefix: '',
    categoryPromptPrefix: '',
    groupPromptPrefix: '',
  })
  const [reportStatus, setReportStatus] = useState('')
  const [reportDownload, setReportDownload] = useState('')
  const [llmLogs, setLlmLogs] = useState<LlmLogEntry[]>([])
  const [llmLogsLoading, setLlmLogsLoading] = useState(false)
  const [llmLogsError, setLlmLogsError] = useState('')

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const activeRecordingTarget = useRef<string | null>(null)
  const pageSliderRef = useRef<HTMLDivElement | null>(null)
  const pageScrollFrameRef = useRef<number | null>(null)
  const recorder = useVoiceRecorder()

  const isAppHistoryState = (value: unknown): value is AppHistoryState => {
    if (!value || typeof value !== 'object') {
      return false
    }
    const candidate = value as Partial<AppHistoryState>
    return (
      (candidate.tab === 'capture' || candidate.tab === 'inbox' || candidate.tab === 'inspiration' || candidate.tab === 'board') &&
      typeof candidate.selectedNoteId === 'string'
    )
  }

  const pushAppState = (tab: TabKey, selected: string) => {
    const nextState: AppHistoryState = { tab, selectedNoteId: selected }
    const currentState = isAppHistoryState(window.history.state) ? window.history.state : null
    if (currentState && currentState.tab === nextState.tab && currentState.selectedNoteId === nextState.selectedNoteId) {
      return
    }
    window.history.pushState(nextState, '', window.location.href)
  }

  const selectedNote = useMemo(() => notes.find((note) => note.id === selectedNoteId) ?? null, [notes, selectedNoteId])

  const persistBoardGroups = async (groups: BoardGroup[]) => {
    const drafts: BoardGroupDraft[] = groups.map((group) => ({
      key: group.key,
      title: group.title,
      description: group.description,
      source: group.source,
      noteIds: group.notes.map((note) => note.id),
    }))
    try {
      await api.saveBoardGroups(drafts)
    } catch {
      // Cache persistence should not block rendering.
    }
  }

  const reloadBoardGroups = async (nextNotes: NoteNode[] = notes) => {
    setBoardGroupsLoading(true)
    try {
      const response = await api.loadBoardGroups()
      if (response.groups.length > 0) {
        setBoardGroups(response.groups)
        return response.groups
      }

      const fallbackGroups = createBoardGroups(nextNotes)
      setBoardGroups(fallbackGroups)
      void persistBoardGroups(fallbackGroups)
      return fallbackGroups
    } catch {
      const fallbackGroups = createBoardGroups(nextNotes)
      setBoardGroups(fallbackGroups)
      void persistBoardGroups(fallbackGroups)
      return fallbackGroups
    } finally {
      setBoardGroupsLoading(false)
    }
  }

  const openBoardGroupEditor = (group?: BoardGroup) => {
    setBoardGroupEditorMode(group ? 'edit' : 'create')
    setBoardGroupEditorDraft({
      key: group?.key ?? makeBoardGroupKey(),
      title: group?.title ?? '',
      description: group?.description ?? '',
      source: 'manual',
      noteIds: group?.notes.map((note) => note.id) ?? [],
    })
    setBoardGroupEditorError('')
    setBoardGroupEditorOpen(true)
  }

  const closeBoardGroupEditor = () => {
    setBoardGroupEditorOpen(false)
    setBoardGroupEditorError('')
  }

  const saveBoardGroupEditor = async () => {
    const title = boardGroupEditorDraft.title.trim()
    const description = boardGroupEditorDraft.description.trim()
    const nextSelected = uniqueStrings(boardGroupEditorDraft.noteIds, 999)
    if (!title) {
      setBoardGroupEditorError('Bitte gib der Gruppe einen Titel.')
      return
    }

    const selectedIds = new Set(nextSelected)
    const noteById = new Map(notes.map((note) => [note.id, note]))
    const selectedNotes = nextSelected.map((noteId) => noteById.get(noteId)).filter((note): note is NoteNode => Boolean(note))
    const selectedNotesById = new Map(selectedNotes.map((note) => [note.id, note]))

    const nextGroups: BoardGroup[] = []
    for (const group of boardGroups) {
      if (group.key === boardGroupEditorDraft.key) {
        continue
      }
      const remainingNotes = group.notes.filter((note) => !selectedIds.has(note.id))
      if (group.source === 'manual') {
        nextGroups.push({ ...group, notes: remainingNotes })
        continue
      }
      if (remainingNotes.length < 2) {
        continue
      }
      nextGroups.push({ ...group, notes: remainingNotes })
    }

    nextGroups.push({
      key: boardGroupEditorDraft.key || makeBoardGroupKey(),
      title,
      description,
      source: 'manual',
      notes: [...selectedNotesById.values()].sort((left, right) => {
        const rightTime = new Date(right.updatedAt).getTime()
        const leftTime = new Date(left.updatedAt).getTime()
        return rightTime - leftTime
      }),
    })

    try {
      const savedGroups = await runBusy('Gruppe wird gespeichert …', async () => {
        return api.saveBoardGroups(
          nextGroups.map((group) => ({
            key: group.key,
            title: group.title,
            description: group.description,
            source: group.source,
            noteIds: group.notes.map((note) => note.id),
          })),
        )
      })
      setBoardGroups(savedGroups.groups)
      closeBoardGroupEditor()
    } catch (error) {
      setBoardGroupEditorError(error instanceof Error ? error.message : 'Die Gruppe konnte nicht gespeichert werden.')
    }
  }

  const reloadNotes = async () => {
    const response = await api.listNotes()
    setNotes(response.notes)
    await reloadBoardGroups(response.notes)
    if (selectedNoteId && !response.notes.some((note) => note.id === selectedNoteId)) {
      setSelectedNoteId('')
    }
    if (expandedInboxNoteId && !response.notes.some((note) => note.id === expandedInboxNoteId)) {
      setExpandedInboxNoteId('')
    }
    return response.notes
  }

  const reloadSettings = async () => {
    const response = await api.loadSettings()
    setSettings(response)
    setSettingsDraft({
      openAiApiKey: '',
      openAiModel: response.openAiModel,
      transcriptionModel: response.transcriptionModel,
      summaryModel: response.summaryModel,
      followUpModel: response.followUpModel,
      language: response.language,
      transcriptionPrompt: response.transcriptionPrompt,
      summaryPromptPrefix: response.summaryPromptPrefix,
      categoryPromptPrefix: response.categoryPromptPrefix,
      groupPromptPrefix: response.groupPromptPrefix,
    })
    return response
  }

  const loadLlmLogs = async () => {
    setLlmLogsLoading(true)
    setLlmLogsError('')
    try {
      const response = await api.loadLlmLogs(80)
      setLlmLogs(response.logs)
    } catch (loadError) {
      setLlmLogs([])
      setLlmLogsError(loadError instanceof Error ? loadError.message : 'Das Protokoll konnte nicht geladen werden.')
    } finally {
      setLlmLogsLoading(false)
    }
  }

  const loadInspirationSuggestion = async () => {
    setInspirationLoading(true)
    setInspirationError('')
    try {
      const response = await runBusy('Inspiration wird gesucht …', async () => api.createInspiration())
      setInspirationSuggestion(response)
    } catch (inspirationLoadError) {
      setInspirationError(inspirationLoadError instanceof Error ? inspirationLoadError.message : 'Die Inspiration konnte nicht geladen werden.')
    } finally {
      setInspirationLoading(false)
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        await Promise.all([reloadNotes(), reloadSettings()])
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Die App konnte nicht geladen werden.')
      }
    })()
  }, [])

  useEffect(() => {
    if (!settingsOpen) {
      return
    }
    void loadLlmLogs()
  }, [settingsOpen])

  useEffect(() => {
    const currentState = isAppHistoryState(window.history.state) ? window.history.state : null
    if (currentState) {
      setActiveTab(currentState.tab)
      setSelectedNoteId('')
      window.history.replaceState({ tab: currentState.tab, selectedNoteId: '' } satisfies AppHistoryState, '', window.location.href)
      window.requestAnimationFrame(() => scrollToTab(currentState.tab, 'auto'))
    } else {
      window.history.replaceState({ tab: activeTab, selectedNoteId } satisfies AppHistoryState, '', window.location.href)
    }

    const handlePopState = (event: PopStateEvent) => {
      const nextState = isAppHistoryState(event.state) ? event.state : { tab: 'capture' as TabKey, selectedNoteId: '' }
      setActiveTab(nextState.tab)
      setSelectedNoteId(nextState.selectedNoteId)
      window.requestAnimationFrame(() => scrollToTab(nextState.tab, 'auto'))
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    if (!recorder.error) {
      return
    }
    setError(recorder.error)
  }, [recorder.error])

  useEffect(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio()
      audioRef.current.addEventListener('ended', () => setPlayingId(''))
    }
    return () => {
      audioRef.current?.pause()
      audioRef.current = null
    }
  }, [])

  useEffect(() => {
    if (selectedNoteId && !selectedNote) {
      setSelectedNoteId('')
    }
  }, [selectedNote, selectedNoteId])

  useEffect(() => {
    return () => {
      if (pageScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(pageScrollFrameRef.current)
      }
    }
  }, [])

  const runBusy = async <T,>(message: string, action: () => Promise<T>) => {
    setBusy({ message })
    try {
      return await action()
    } finally {
      setBusy(null)
    }
  }

  const updateNotesFromResponse = async (response: { note: NoteNode }) => {
    const freshNotes = await reloadNotes()
    const current = freshNotes.find((note) => note.id === response.note.id) ?? response.note
    setSelectedNoteId(current.id)
    return current
  }

  const openNoteDetail = (noteId: string) => {
    pushAppState(activeTab, noteId)
    setSelectedNoteId(noteId)
  }

  const toggleInboxNoteExpansion = (noteId: string) => {
    setExpandedInboxNoteId((current) => (current === noteId ? '' : noteId))
  }

  const openExpandedInboxNoteDetail = () => {
    if (!expandedInboxNoteId) {
      return
    }
    openNoteDetail(expandedInboxNoteId)
  }

  const closeNoteDetail = () => {
    if (selectedNoteId && isAppHistoryState(window.history.state)) {
      window.history.back()
      return
    }
    setSelectedNoteId('')
  }

  const waitForProcessedNote = async (noteId: string) => {
    let noteResponse = await api.getNote(noteId)
    for (let attempt = 0; attempt < 20 && isProcessingNote(noteResponse.note); attempt += 1) {
      await sleep(800)
      noteResponse = await api.getNote(noteId)
    }
    return noteResponse.note
  }

  const finishVoiceCapture = async (response: { note: NoteNode }) => {
    const readyNote = isProcessingNote(response.note) ? await waitForProcessedNote(response.note.id) : response.note
    const current = await updateNotesFromResponse({ note: readyNote })
    openNoteDetail(current.id)
  }

  const startVoiceCapture = async (noteId?: string) => {
    if (recorder.isRecording || busy) {
      return
    }
    setTextNoteOpen(false)
    activeRecordingTarget.current = noteId ?? null
    void recorder.startRecording().catch((captureError) => {
      activeRecordingTarget.current = null
      setError(captureError instanceof Error ? captureError.message : 'Die Aufnahme konnte nicht gestartet werden.')
    })
  }

  const stopVoiceCapture = async () => {
    const recorded = await recorder.stopRecording()
    const target = activeRecordingTarget.current
    activeRecordingTarget.current = null
    if (!recorded) {
      return
    }
    const response = await runBusy('Sprachnotiz wird verarbeitet …', async () => {
      return target ? api.createVoiceNote(recorded.blob, recorded.mimeType, target) : api.createVoiceNote(recorded.blob, recorded.mimeType)
    })
    await finishVoiceCapture(response)
  }

  const submitTextNote = async () => {
    if (busy || recorder.isRecording) {
      return
    }
    const clean = noteDraft.trim()
    if (!clean) {
      setError('Bitte erst Text für die Notiz eingeben.')
      return
    }
    setNoteDraft('')
    const response = await runBusy('Textnotiz wird aufbereitet …', async () => api.createTextNote(clean))
    const note = await updateNotesFromResponse(response)
    setTextNoteOpen(false)
    openNoteDetail(note.id)
  }

  const runAllNotesRoutine = async () => {
    const response = await runBusy('Kategorien werden neu erstellt …', async () => api.reanalyzeAllNotes())
    await reloadNotes()
    await loadLlmLogs()
    setRoutineStatus(`Kategorien neu erstellt: ${response.updatedNotes} Notizen aktualisiert${response.skippedNotes ? `, ${response.skippedNotes} übersprungen` : ''}`)
  }

  const runAllNotesTranscriptRoutine = async () => {
    const response = await runBusy('Transkripte werden neu erstellt …', async () => api.retranscribeAllNotes())
    await reloadNotes()
    await loadLlmLogs()
    setRoutineStatus(`Transkripte neu erstellt: ${response.updatedNotes} Notizen aktualisiert${response.skippedNotes ? `, ${response.skippedNotes} übersprungen` : ''}`)
  }

  const runBoardGroupingRoutine = async () => {
    const groups = await runBusy('Gruppen werden neu erstellt …', async () => api.groupNotes())
    setBoardGroups(groups.groups)
    await loadLlmLogs()
    setRoutineStatus(`Gruppen neu erstellt: ${groups.groups.length} Spalten`)
  }

  const deleteSelectedNote = async () => {
    if (!deleteNoteTarget) {
      return
    }
    await runBusy('Notiz wird gelöscht …', async () => api.deleteNote(deleteNoteTarget.id))
    setDeleteNoteTarget(null)
    closeNoteDetail()
    await reloadNotes()
  }

  const changeSelectedNoteCategory = async (category: NoteCategory) => {
    if (!selectedNote) {
      return
    }
    const noteId = selectedNote.id
    setNotes((currentNotes) => currentNotes.map((note) => (note.id === noteId ? { ...note, category } : note)))
    try {
      const response = await runBusy('Klasse wird geändert …', async () => api.updateNoteCategory(noteId, category))
      await updateNotesFromResponse(response)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Die Klasse konnte nicht geändert werden.')
      await reloadNotes()
    }
  }

  const rebuildSelectedNote = async () => {
    if (!selectedNote) {
      return
    }
    const voiceEntries = selectedNote.entries.filter((entry) => Boolean(entry.audioRelativePath.trim()))
    const response = await runBusy('Notiz wird neu zusammengefasst und transkribiert …', async () => {
      for (const entry of voiceEntries) {
        await api.retryTranscription(selectedNote.id, entry.id)
      }
      return api.analyzeNote(selectedNote.id)
    })
    await updateNotesFromResponse(response)
  }

  const reanalyzeSelectedNoteCategory = async () => {
    if (!selectedNote) {
      return
    }
    const response = await runBusy('Kategorie wird neu ermittelt …', async () => api.analyzeNote(selectedNote.id))
    await updateNotesFromResponse(response)
  }

  const updateSelectedNoteTranscript = async (transcript: string) => {
    if (!selectedNote) {
      return
    }
    const noteId = selectedNote.id
    const response = await runBusy('Transkript wird gespeichert …', async () => api.updateNoteTranscript(noteId, transcript))
    await updateNotesFromResponse(response)
  }

  const deleteAllNotes = async () => {
    await runBusy('Alle Notizen werden gelöscht …', async () => api.deleteAllNotes())
    setDeleteAllOpen(false)
    setSelectedNoteId('')
    setExpandedInboxNoteId('')
    await reloadNotes()
  }

  const saveSettings = async () => {
    const response = await runBusy('Einstellungen werden gespeichert …', async () =>
      api.saveSettings({
        openAiApiKey: settingsDraft.openAiApiKey.trim() || undefined,
        openAiModel: settingsDraft.openAiModel.trim() || undefined,
        transcriptionModel: settingsDraft.transcriptionModel.trim() || undefined,
        summaryModel: settingsDraft.summaryModel.trim() || undefined,
        followUpModel: settingsDraft.followUpModel.trim() || undefined,
        language: settingsDraft.language.trim() || undefined,
        transcriptionPrompt: settingsDraft.transcriptionPrompt,
        summaryPromptPrefix: settingsDraft.summaryPromptPrefix,
        categoryPromptPrefix: settingsDraft.categoryPromptPrefix,
        groupPromptPrefix: settingsDraft.groupPromptPrefix,
      }),
    )
    setSettings(response)
    setSettingsDraft((current) => ({
      ...current,
      openAiApiKey: '',
      openAiModel: response.openAiModel,
      transcriptionModel: response.transcriptionModel,
      summaryModel: response.summaryModel,
      followUpModel: response.followUpModel,
      language: response.language,
      transcriptionPrompt: response.transcriptionPrompt,
      summaryPromptPrefix: response.summaryPromptPrefix,
      categoryPromptPrefix: response.categoryPromptPrefix,
      groupPromptPrefix: response.groupPromptPrefix,
    }))
    await reloadBoardGroups()
  }

  const exportTechnicalReport = async () => {
    const response = await runBusy('Technischer Report wird erstellt …', async () => api.exportTechnicalReport())
    downloadMarkdown(response.fileName, response.reportMarkdown)
    setReportStatus(`Export abgeschlossen: ${response.fileName}`)
    setReportDownload(response.fileName)
  }

  const playAudio = async (noteOrEntryId: string, url: string) => {
    const audio = audioRef.current
    if (!audio) {
      return
    }
    if (playingId === noteOrEntryId) {
      audio.pause()
      audio.currentTime = 0
      setPlayingId('')
      return
    }
    audio.pause()
    audio.currentTime = 0
    audio.src = url
    try {
      await audio.play()
      setPlayingId(noteOrEntryId)
    } catch {
      setError('Audio konnte nicht abgespielt werden.')
    }
  }

  const scrollToTab = (tab: TabKey, behavior: ScrollBehavior = 'smooth') => {
    const slider = pageSliderRef.current
    if (!slider) {
      return
    }
    const index = tabs.findIndex((item) => item.key === tab)
    if (index < 0) {
      return
    }
    slider.scrollTo({ left: slider.clientWidth * index, behavior })
  }

  const activateTab = (tab: TabKey) => {
    if (selectedNoteId) {
      pushAppState(tab, '')
      setSelectedNoteId('')
    } else {
      pushAppState(tab, selectedNoteId)
    }
    setActiveTab(tab)
    scrollToTab(tab)
  }

  const handlePageScroll = () => {
    if (pageScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(pageScrollFrameRef.current)
    }
    pageScrollFrameRef.current = window.requestAnimationFrame(() => {
      const slider = pageSliderRef.current
      if (!slider) {
        return
      }
      const nextIndex = Math.max(0, Math.min(tabs.length - 1, Math.round(slider.scrollLeft / Math.max(slider.clientWidth, 1))))
      const nextTab = tabs[nextIndex]?.key
      if (nextTab && nextTab !== activeTab) {
        setActiveTab(nextTab)
      }
    })
  }

  const noteCount = notes.length
  const captureStartEnabled = !busy && !recorder.isRecording
  const isDesktopMode = typeof window !== 'undefined' && (window.location.pathname === '/desktop' || window.location.pathname.startsWith('/desktop/'))

  if (isDesktopMode) {
    const categoryCounts = notes.reduce(
      (accumulator, note) => {
        accumulator[note.category || ''] += 1
        return accumulator
      },
      { '': 0, Idea: 0, Task: 0 } as Record<NoteCategory, number>,
    )

    return (
      <div className="bootstrap-app text-body desktop-mode">
        <div className="container-fluid desktop-shell py-3 py-xl-4 d-flex flex-column gap-3">
          <header className="desktop-topbar card border-0 shadow-sm">
            <div className="card-body p-3 p-lg-4 d-flex flex-column flex-xl-row align-items-start align-items-xl-center justify-content-between gap-3">
              <div className="desktop-top-copy">
                <p className="small text-uppercase text-secondary fw-semibold mb-1">Desktop-Pinnwand</p>
                <h1 className="desktop-title mb-1">BrainSession</h1>
                <p className="desktop-subtitle mb-0">Getrennte Desktop-Ansicht mit derselben Datenbasis wie die PWA.</p>
              </div>
              <div className="d-flex flex-wrap align-items-center gap-2">
                <span className="badge rounded-pill text-bg-light border text-secondary">
                  <i className="bi bi-journal-text me-1" aria-hidden="true" />
                  {noteCount} Notizen
                </span>
                <button className="btn btn-outline-secondary btn-sm" type="button" onClick={() => window.location.assign('/')}>
                  <i className="bi bi-phone me-1" aria-hidden="true" />
                  PWA öffnen
                </button>
                <button className="btn btn-outline-secondary btn-sm" type="button" onClick={() => setSettingsOpen(true)} aria-label="Einstellungen öffnen">
                  <i className="bi bi-gear-fill" aria-hidden="true" />
                </button>
              </div>
            </div>
          </header>

          <div className="desktop-layout flex-grow-1 d-flex gap-3 min-h-0">
            <aside className="desktop-sidebar card border-0 shadow-sm">
              <div className="card-body p-3 p-lg-4 d-flex flex-column gap-3 h-100">
                <div className="desktop-sidebar-header d-flex flex-column gap-2">
                  <span className="badge rounded-pill text-bg-light border text-secondary align-self-start">Voice first</span>
                  <h2 className="h4 mb-0">Notizen aufnehmen</h2>
                  <p className="text-secondary mb-0">Die Aufnahme sitzt links, damit die Pinnwand frei bleibt.</p>
                </div>

                <div className="desktop-record-zone text-center d-flex flex-column align-items-center gap-3">
                  <button
                    className="btn btn-primary rounded-circle desktop-record-button d-inline-flex align-items-center justify-content-center"
                    onClick={() => void startVoiceCapture()}
                    type="button"
                    disabled={recorder.isRecording || !captureStartEnabled}
                    aria-label={recorder.isRecording ? 'Aufnahme läuft' : 'Sprachnotiz aufnehmen'}
                  >
                    <i className={`bi ${recorder.isRecording ? 'bi-stop-fill' : 'bi-mic-fill'} desktop-record-icon`} aria-hidden="true" />
                  </button>
                  <div>
                    <p className="h5 mb-1">Sprachnotiz aufnehmen</p>
                    <p className="text-secondary mb-0">Eine große Taste, daneben Textnotizen und Einstellungen.</p>
                  </div>
                  {recorder.microphoneHint ? <div className="alert alert-warning mb-0 py-2 w-100">{recorder.microphoneHint}</div> : null}
                </div>

                <div className="desktop-quick-actions d-grid gap-2">
                  <button className="btn btn-outline-secondary" onClick={() => setTextNoteOpen(true)} type="button">
                    <i className="bi bi-pencil-square me-1" aria-hidden="true" />
                    Textnotiz
                  </button>
                  <button className="btn btn-outline-primary" onClick={() => setSettingsOpen(true)} type="button">
                    <i className="bi bi-gear-fill me-1" aria-hidden="true" />
                    Einstellungen
                  </button>
                  <button className="btn btn-outline-primary" onClick={() => void reloadNotes()} type="button">
                    <i className="bi bi-arrow-clockwise me-1" aria-hidden="true" />
                    Pinnwand aktualisieren
                  </button>
                </div>

                <div className="desktop-stats card border-0 shadow-sm mt-auto">
                  <div className="card-body p-3 d-flex flex-column gap-3">
                    <div className="d-flex align-items-center justify-content-between gap-2">
                      <h3 className="h6 mb-0">Übersicht</h3>
                      <span className="badge rounded-pill text-bg-light border text-secondary">{noteCount}</span>
                    </div>
                    <div className="d-flex flex-wrap gap-2">
                      <span className="badge rounded-pill board-kind-badge">Notiz {categoryCounts['']}</span>
                      <span className="badge rounded-pill board-kind-badge">Idee {categoryCounts.Idea}</span>
                      <span className="badge rounded-pill board-kind-badge">To-Do {categoryCounts.Task}</span>
                    </div>
                    <p className="text-secondary mb-0">Alle Einträge landen im selben Backend, die Desktop-Ansicht bleibt aber separat erreichbar.</p>
                  </div>
                </div>

                <button className="btn btn-link text-decoration-none align-self-start px-0" type="button" onClick={() => window.location.assign('/')}>
                  Zur mobilen PWA zurück
                </button>
              </div>
            </aside>

            <main className="desktop-stage flex-grow-1 d-flex flex-column gap-3 min-h-0">
              <div className="desktop-board-grid flex-grow-1 min-h-0">
                <BoardView
                  groups={boardGroups}
                  loading={boardGroupsLoading}
                  selectedNoteId={selectedNoteId}
                  onOpenNote={openNoteDetail}
                  onTogglePlayback={(id, url) => void playAudio(id, url)}
                  currentlyPlayingId={playingId}
                  onCreateGroups={() => void runBoardGroupingRoutine()}
                  onCreateGroup={() => openBoardGroupEditor()}
                  onEditGroup={(group) => openBoardGroupEditor(group)}
                />
              </div>
            </main>
          </div>

          {selectedNote ? (
            <div className="overlay-backdrop overlay-dark desktop-note-backdrop" onClick={closeNoteDetail}>
            <div className="modal-panel note-detail-panel desktop-note-panel" onClick={(event) => event.stopPropagation()}>
          <NoteDetailPage
              note={selectedNote}
              onClose={closeNoteDetail}
              onDeleteNote={() => setDeleteNoteTarget(selectedNote)}
              onTogglePlayback={(id, url) => void playAudio(id, url)}
              onChangeCategory={(category) => changeSelectedNoteCategory(category)}
              onRebuildNote={() => void rebuildSelectedNote()}
              onReanalyzeCategory={() => void reanalyzeSelectedNoteCategory()}
              onUpdateTranscript={(transcript) => updateSelectedNoteTranscript(transcript)}
            />
              </div>
            </div>
          ) : null}

          {settingsOpen && settings && (
            <SettingsModal
              settings={settings}
              settingsDraft={settingsDraft}
              setSettingsDraft={setSettingsDraft}
              onClose={() => setSettingsOpen(false)}
              onSave={() => void saveSettings()}
              onExportTechnicalReport={() => void exportTechnicalReport()}
              reportStatus={reportStatus}
              reportDownload={reportDownload}
              routineStatus={routineStatus}
              onRunAllNotesRoutine={() => void runAllNotesRoutine()}
              onRunAllNotesTranscriptRoutine={() => void runAllNotesTranscriptRoutine()}
              onRunBoardGroupingRoutine={() => void runBoardGroupingRoutine()}
              onDeleteAllNotes={() => setDeleteAllOpen(true)}
              onRefreshLlmLogs={() => void loadLlmLogs()}
              llmLogs={llmLogs}
              llmLogsLoading={llmLogsLoading}
              llmLogsError={llmLogsError}
            />
          )}

          {textNoteOpen && (
            <TextNoteModal
              noteDraft={noteDraft}
              setNoteDraft={setNoteDraft}
              onSubmit={() => void submitTextNote()}
              onClose={() => setTextNoteOpen(false)}
              submitting={busy !== null}
            />
          )}

          {recorder.isRecording && <RecordingOverlay levels={recorder.levels} onStop={() => void stopVoiceCapture()} />}
          {busy && <LoadingOverlay message={busy.message} />}
          {error && <ErrorOverlay message={error} onDismiss={() => setError('')} />}

          {deleteNoteTarget && (
            <ConfirmationModal
              title="Notiz löschen?"
              message={`Die Notiz „${noteTitle(deleteNoteTarget)}“ wird dauerhaft entfernt.`}
              confirmLabel="Löschen"
              cancelLabel="Abbrechen"
              destructive
              onConfirm={() => void deleteSelectedNote()}
              onCancel={() => setDeleteNoteTarget(null)}
            />
          )}

          {deleteAllOpen && (
            <ConfirmationModal
              title="Alle Notizen löschen?"
              message="Damit werden alle Notizen und Aufnahmen aus dem lokalen Speicher entfernt."
              confirmLabel="Alle löschen"
              cancelLabel="Abbrechen"
              destructive
              onConfirm={() => void deleteAllNotes()}
              onCancel={() => setDeleteAllOpen(false)}
            />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="bootstrap-app text-body">
      <div className="container-fluid app-shell py-2 py-lg-3 d-flex flex-column gap-2">
        <header className="app-header d-flex align-items-start align-items-lg-center justify-content-between gap-3">
          <div>
            <div className="app-brand">BrainSession</div>
            <div className="app-subtitle">Dein externer RAM für Sprachideen und Post-its.</div>
          </div>
          <div className="d-flex align-items-center gap-2">
            <span className="badge rounded-pill text-bg-light border text-secondary d-none d-sm-inline-flex">
              <i className="bi bi-journal-text me-1" aria-hidden="true" />
              {noteCount} Notizen
            </span>
            <button className="btn btn-outline-secondary btn-sm" type="button" onClick={() => setSettingsOpen(true)} aria-label="Einstellungen öffnen">
              <i className="bi bi-gear-fill" aria-hidden="true" />
            </button>
          </div>
        </header>

        <main className="flex-grow-1 overflow-hidden pt-0 pb-0">
          {selectedNote ? (
            <NoteDetailPage
              note={selectedNote}
              onClose={closeNoteDetail}
              onDeleteNote={() => setDeleteNoteTarget(selectedNote)}
              onTogglePlayback={(id, url) => void playAudio(id, url)}
              onChangeCategory={(category) => changeSelectedNoteCategory(category)}
              onRebuildNote={() => void rebuildSelectedNote()}
              onReanalyzeCategory={() => void reanalyzeSelectedNoteCategory()}
              onUpdateTranscript={(transcript) => updateSelectedNoteTranscript(transcript)}
            />
          ) : (
            <div className="page-slider h-100" ref={pageSliderRef} onScroll={handlePageScroll}>
              <section className="page-panel h-100 d-flex flex-column gap-3">
                <SparkView
                  startVoiceCapture={() => void startVoiceCapture()}
                  isRecording={recorder.isRecording}
                  startEnabled={captureStartEnabled}
                  microphoneHint={recorder.microphoneHint}
                  onOpenTextNote={() => setTextNoteOpen(true)}
                  onOpenInbox={() => activateTab('inbox')}
                  onOpenBoard={() => activateTab('board')}
                  noteCount={noteCount}
                />
              </section>

              <section className="page-panel h-100 d-flex flex-column gap-3">
                <InboxView
                  notes={notes}
                  expandedNoteId={expandedInboxNoteId}
                  onToggleExpandNote={toggleInboxNoteExpansion}
                  onOpenNoteDetail={openExpandedInboxNoteDetail}
                  onTogglePlayback={(id, url) => void playAudio(id, url)}
                  currentlyPlayingId={playingId}
                />
              </section>

              <section className="page-panel h-100 d-flex flex-column gap-3">
                <InspirationView
                  noteCount={noteCount}
                  suggestion={inspirationSuggestion}
                  loading={inspirationLoading}
                  error={inspirationError}
                  onGenerate={() => void loadInspirationSuggestion()}
                />
              </section>

              <section className="page-panel h-100 d-flex flex-column gap-3">
              <BoardView
                groups={boardGroups}
                loading={boardGroupsLoading}
                selectedNoteId={selectedNoteId}
                onOpenNote={openNoteDetail}
                onTogglePlayback={(id, url) => void playAudio(id, url)}
                currentlyPlayingId={playingId}
                onCreateGroups={() => void runBoardGroupingRoutine()}
                onCreateGroup={() => openBoardGroupEditor()}
                onEditGroup={(group) => openBoardGroupEditor(group)}
              />
              </section>
            </div>
          )}
        </main>

        <nav className="navbar navbar-expand fixed-bottom border-top bg-white shadow-sm app-bottom-nav" aria-label="Seitennavigation">
          <div className="container-fluid px-3 px-lg-4 py-2">
            <div className="nav nav-pills w-100 justify-content-between justify-content-md-center gap-2 app-bottom-nav-pills" role="tablist" aria-label="App-Seiten">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  className={`nav-link btn btn-sm rounded-pill px-3 px-md-4 py-2 ${activeTab === tab.key ? 'active' : ''}`}
                  onClick={() => activateTab(tab.key)}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.key}
                  aria-label={tab.label}
                >
                  <span className="d-flex flex-column align-items-center justify-content-center gap-1 lh-1">
                    <i className={`bi ${tab.icon} fs-5`} aria-hidden="true" />
                    <span className="app-nav-dot" aria-hidden="true" />
                    <span className="small fw-semibold">{tab.label}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </nav>

        {textNoteOpen && (
          <TextNoteModal
            noteDraft={noteDraft}
            setNoteDraft={setNoteDraft}
            onSubmit={() => void submitTextNote()}
            onClose={() => setTextNoteOpen(false)}
            submitting={busy !== null}
          />
        )}

        {boardGroupEditorOpen && (
          <BoardGroupEditorModal
            mode={boardGroupEditorMode}
            draft={boardGroupEditorDraft}
            setDraft={setBoardGroupEditorDraft}
            notes={notes}
            groups={boardGroups}
            error={boardGroupEditorError}
            onClose={closeBoardGroupEditor}
            onSave={() => void saveBoardGroupEditor()}
            saving={busy !== null}
          />
        )}

        {settingsOpen && settings && (
          <SettingsModal
            settings={settings}
            settingsDraft={settingsDraft}
            setSettingsDraft={setSettingsDraft}
            onClose={() => setSettingsOpen(false)}
            onSave={() => void saveSettings()}
            onExportTechnicalReport={() => void exportTechnicalReport()}
            reportStatus={reportStatus}
            reportDownload={reportDownload}
            routineStatus={routineStatus}
            onRunAllNotesRoutine={() => void runAllNotesRoutine()}
            onRunAllNotesTranscriptRoutine={() => void runAllNotesTranscriptRoutine()}
            onRunBoardGroupingRoutine={() => void runBoardGroupingRoutine()}
            onDeleteAllNotes={() => setDeleteAllOpen(true)}
            onRefreshLlmLogs={() => void loadLlmLogs()}
            llmLogs={llmLogs}
            llmLogsLoading={llmLogsLoading}
            llmLogsError={llmLogsError}
          />
        )}

        {recorder.isRecording && <RecordingOverlay levels={recorder.levels} onStop={() => void stopVoiceCapture()} />}
        {busy && <LoadingOverlay message={busy.message} />}
        {error && <ErrorOverlay message={error} onDismiss={() => setError('')} />}

        {deleteNoteTarget && (
          <ConfirmationModal
            title="Notiz löschen?"
            message={`Die Notiz „${noteTitle(deleteNoteTarget)}“ wird dauerhaft entfernt.`}
            confirmLabel="Löschen"
            cancelLabel="Abbrechen"
            destructive
            onConfirm={() => void deleteSelectedNote()}
            onCancel={() => setDeleteNoteTarget(null)}
          />
        )}

        {deleteAllOpen && (
          <ConfirmationModal
            title="Alle Notizen löschen?"
            message="Damit werden alle Notizen und Aufnahmen aus dem lokalen Speicher entfernt."
            confirmLabel="Alle löschen"
            cancelLabel="Abbrechen"
            destructive
            onConfirm={() => void deleteAllNotes()}
            onCancel={() => setDeleteAllOpen(false)}
          />
        )}
      </div>
    </div>
  )
}

function SparkView(props: {
  startVoiceCapture: () => void
  isRecording: boolean
  startEnabled: boolean
  microphoneHint: string
  onOpenTextNote: () => void
  onOpenInbox: () => void
  onOpenBoard: () => void
  noteCount: number
}) {
  return (
    <section className="spark-view h-100 d-flex flex-column gap-3">
      <div className="spark-hero card border-0 shadow-sm">
        <div className="card-body p-3 p-lg-4 d-flex flex-column gap-2">
          <span className="badge rounded-pill text-bg-light border text-secondary align-self-start">Voice first</span>
          <h1 className="spark-title mb-0">Sprich los. BrainSession sortiert den Rest.</h1>
          <p className="spark-copy text-secondary mb-0">Notizen bleiben clean, deutsch und erst auf Klick vollständig sichtbar.</p>
        </div>
      </div>

      <div className="spark-stage card border-0 shadow-sm flex-grow-1">
        <div className="card-body p-3 p-lg-4 d-flex flex-column justify-content-between gap-3 h-100">
          <div className="spark-microcopy d-flex flex-wrap gap-2">
            <span className="badge rounded-pill text-bg-light border text-secondary">{props.noteCount} gespeicherte Notizen</span>
            <span className="badge rounded-pill text-bg-light border text-secondary">Swipe links für Eingang und Board</span>
          </div>

          <div className="d-flex flex-column align-items-center text-center gap-3 py-3 py-lg-4">
            <button
              className="btn btn-primary rounded-circle voice-cta d-inline-flex align-items-center justify-content-center"
              onClick={props.startVoiceCapture}
              type="button"
              disabled={props.isRecording || !props.startEnabled}
              aria-label={props.isRecording ? 'Aufnahme läuft' : 'Sprachnotiz aufnehmen'}
            >
              <i className={`bi ${props.isRecording ? 'bi-stop-fill' : 'bi-mic-fill'} voice-cta-icon`} aria-hidden="true" />
            </button>
            <div>
              <h2 className="h4 mb-1">Sprachnotiz aufnehmen</h2>
              <p className="text-secondary mb-0">Der Button bleibt groß und klar. Alles andere bleibt ruhig im Hintergrund.</p>
            </div>
            {props.microphoneHint ? <div className="alert alert-warning mb-0 py-2 w-100">{props.microphoneHint}</div> : null}
          </div>

          <div className="d-grid gap-2 d-sm-flex">
            <button className="btn btn-outline-secondary flex-grow-1" onClick={props.onOpenTextNote} type="button">
              <i className="bi bi-pencil-square me-1" aria-hidden="true" />
              Textnotiz
            </button>
            <button className="btn btn-outline-primary flex-grow-1" onClick={props.onOpenInbox} type="button">
              <i className="bi bi-inbox-fill me-1" aria-hidden="true" />
              Eingang öffnen
            </button>
            <button className="btn btn-outline-primary flex-grow-1" onClick={props.onOpenBoard} type="button">
              <i className="bi bi-kanban-fill me-1" aria-hidden="true" />
              Board öffnen
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

function InspirationView(props: {
  noteCount: number
  suggestion: InspirationSuggestion | null
  loading: boolean
  error: string
  onGenerate: () => void
}) {
  return (
    <section className="inspiration-view h-100 d-flex flex-column gap-3">
      <div className="card border-0 shadow-sm inspiration-hero">
        <div className="card-body p-3 p-lg-4 d-flex flex-column gap-2">
          <span className="badge rounded-pill text-bg-light border text-secondary align-self-start">Zufällige Notiz</span>
          <h2 className="inspiration-title mb-0">Eine konkrete Idee mit sofortiger Folgefrage.</h2>
          <p className="inspiration-copy text-secondary mb-0">
            Die KI zieht eine einzelne Notiz und stellt genau eine Frage, mit der du die Idee direkt weiterdenken kannst.
          </p>
        </div>
      </div>

      <div className="inspiration-panel card border-0 shadow-sm flex-grow-1">
        <div className="card-body p-3 p-lg-4 d-flex flex-column gap-3 h-100">
          <div className="d-flex flex-wrap align-items-center gap-2">
            <span className="badge rounded-pill text-bg-light border text-secondary">{props.noteCount} Notizen im Archiv</span>
            <span className="badge rounded-pill text-bg-light border text-secondary">Eine Notiz pro Klick</span>
          </div>

          <button
            className="btn btn-primary align-self-start rounded-pill px-4"
            type="button"
            onClick={props.onGenerate}
            disabled={props.loading}
          >
            <i className={`bi ${props.loading ? 'bi-hourglass-split' : 'bi-lightbulb-fill'} me-2`} aria-hidden="true" />
            {props.loading ? 'Notiz wird gezogen …' : props.suggestion ? 'Nächste Notiz' : 'Idee holen'}
          </button>

          {props.error ? <div className="alert alert-warning mb-0 py-2">{props.error}</div> : null}

          {props.suggestion ? (
            <div className="inspiration-result card border-0 shadow-none mb-0">
              <div className="card-body p-3 p-lg-4 d-flex flex-column gap-3">
                <div>
                  <div className="small text-uppercase text-secondary fw-semibold mb-1">Bezug</div>
                  <p className="inspiration-title-note mb-0">{props.suggestion.noteTitle || 'Unbenannte Notiz'}</p>
                </div>
                <div>
                  <div className="small text-uppercase text-secondary fw-semibold mb-1">Kurzkontext</div>
                  <p className="inspiration-context mb-0">{props.suggestion.context}</p>
                </div>
                <div>
                  <div className="small text-uppercase text-secondary fw-semibold mb-1">Frage</div>
                  <p className="inspiration-question mb-0">{props.suggestion.question}</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="inspiration-empty text-secondary rounded-4 border border-dashed p-4 flex-grow-1 d-flex align-items-center justify-content-center text-center">
              Drück auf den Button und hol dir in Sekunden einen Gedanken für die nächste freie Minute.
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function InboxView(props: {
  notes: NoteNode[]
  expandedNoteId: string
  onToggleExpandNote: (noteId: string) => void
  onOpenNoteDetail: () => void
  onTogglePlayback: (id: string, url: string) => void
  currentlyPlayingId: string
}) {
  const noteCount = props.notes.length

  return (
    <section className="inbox-view h-100 d-flex flex-column gap-3">
      <div className="card border-0 shadow-sm">
        <div className="card-body p-3 p-lg-4 d-flex flex-column gap-2">
          <div className="d-flex align-items-start justify-content-between gap-3">
            <div>
              <p className="small text-uppercase text-secondary fw-semibold mb-1">Eingang</p>
              <h2 className="h3 mb-0">Post-it-Stapel</h2>
            </div>
            <span className="badge rounded-pill text-bg-light border text-secondary">{noteCount}</span>
          </div>
          <p className="text-secondary mb-0">Die Karten liegen gestapelt. Erst der Titel ist sichtbar, ein Klick klappt die ganze Notiz auf.</p>
        </div>
      </div>

      {props.notes.length === 0 ? (
        <div className="alert alert-light border shadow-sm mb-0">Noch keine Notizen vorhanden. Starte eine Sprachnotiz oder lege Text direkt an.</div>
      ) : (
        <div className="inbox-list stacked-note-pile flex-grow-1">
          {props.notes.map((note, index) => (
            <div
              key={note.id}
              className={`stacked-note-item ${props.expandedNoteId === note.id ? 'stacked-note-item-expanded' : ''}`}
              style={{ zIndex: props.expandedNoteId === note.id ? 1000 : index + 1 }}
            >
              <StickyNoteCard
                note={note}
                selected={false}
                compact={false}
                stacked
                floating={false}
                ghost={props.expandedNoteId === note.id}
                onOpen={() => props.onToggleExpandNote(note.id)}
                onOpenDetail={undefined}
                onTogglePlayback={() => {
                  const audioPath = noteAudioPath(note)
                  if (audioPath) {
                    props.onTogglePlayback(note.id, mediaUrl(audioPath))
                  }
                }}
                playing={props.currentlyPlayingId === note.id}
              />
              {props.expandedNoteId === note.id ? (
                <StickyNoteCard
                  note={note}
                  selected
                  compact={false}
                  stacked
                  floating
                  ghost={false}
                  onOpen={() => props.onToggleExpandNote(note.id)}
                  onOpenDetail={props.onOpenNoteDetail}
                  onTogglePlayback={() => {
                    const audioPath = noteAudioPath(note)
                    if (audioPath) {
                      props.onTogglePlayback(note.id, mediaUrl(audioPath))
                    }
                  }}
                  playing={props.currentlyPlayingId === note.id}
                />
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function BoardView(props: {
  groups: BoardGroup[]
  loading: boolean
  selectedNoteId: string
  onOpenNote: (noteId: string) => void
  onTogglePlayback: (id: string, url: string) => void
  currentlyPlayingId: string
  onCreateGroups: () => void
  onCreateGroup: () => void
  onEditGroup: (group: BoardGroup) => void
}) {
  const hasNotes = props.groups.some((group) => group.notes.length > 0)

  return (
    <section className="board-view h-100 d-flex flex-column gap-3">
      <div className="card border-0 shadow-sm">
        <div className="card-body p-3 p-lg-4 d-flex flex-column gap-2">
          <div className="d-flex align-items-start justify-content-between gap-3">
            <div>
              <p className="small text-uppercase text-secondary fw-semibold mb-1">Board</p>
              <h2 className="h3 mb-0">Eigene Gruppen</h2>
            </div>
            <div className="d-flex flex-column align-items-end gap-2">
              <div className="d-flex flex-wrap justify-content-end gap-2">
                <button className="btn btn-outline-secondary btn-sm" onClick={props.onCreateGroup} type="button">
                  <i className="bi bi-folder-plus me-1" aria-hidden="true" />
                  Neue Gruppe
                </button>
                <button className="btn btn-outline-primary btn-sm" onClick={props.onCreateGroups} type="button">
                  <i className="bi bi-diagram-3-fill me-1" aria-hidden="true" />
                  Neu gruppieren
                </button>
              </div>
              <span className="badge rounded-pill text-bg-light border text-secondary">{props.groups.reduce((count, group) => count + group.notes.length, 0)}</span>
            </div>
          </div>
          <p className="text-secondary mb-0">Eigene Gruppen kannst du mit Titel und Beschreibung anlegen und Karten darin einsortieren. Automatische Gruppen bleiben ebenfalls mit Beschreibung erhalten.</p>
        </div>
      </div>

      {props.loading ? (
        <div className="board-loading-stage card border-0 shadow-sm mb-0">
          <div className="card-body p-4 d-flex flex-column align-items-center justify-content-center text-center gap-3">
            <div className="board-loading-spinner spinner-border text-primary" role="status" aria-hidden="true" />
            <div>
              <p className="small text-uppercase text-secondary fw-semibold mb-1">Gruppen werden vorbereitet</p>
              <h3 className="h5 mb-2">Einen Moment bitte</h3>
              <p className="text-secondary mb-0">Die Poster-Gruppen werden gerade geladen und zusammengestellt. Danach erscheinen sie automatisch hier.</p>
            </div>
            <div className="board-loading-pile w-100 d-flex flex-column gap-2">
              <div className="board-loading-cover skeleton-card" />
              <div className="board-loading-note skeleton-card" />
              <div className="board-loading-note board-loading-note-secondary skeleton-card" />
            </div>
          </div>
        </div>
      ) : !hasNotes ? (
        <div className="alert alert-light border shadow-sm mb-0">Noch keine Notizen vorhanden. Sobald du erste Einträge erfasst, bildet die KI daraus thematische Poster-Gruppen.</div>
      ) : (
        <div className="board-row flex-grow-1 d-flex gap-0 overflow-auto pb-2">
          {props.groups.map((group) => (
            <BoardGroupView
              key={group.key}
              group={group}
              onOpenNote={props.onOpenNote}
              onTogglePlayback={props.onTogglePlayback}
              currentlyPlayingId={props.currentlyPlayingId}
              selectedNoteId={props.selectedNoteId}
              onEditGroup={props.onEditGroup}
            />
          ))}
          <button className="board-column board-column-add card border-0 shadow-sm flex-shrink-0" onClick={props.onCreateGroup} type="button">
            <div className="card-body p-3 d-flex flex-column gap-2 h-100">
              <div className="d-flex align-items-start justify-content-between gap-2">
                <div>
                  <p className="small text-uppercase text-secondary fw-semibold mb-1">Neue Gruppe</p>
                  <h3 className="h5 mb-1 board-column-title">Plus hinzufügen</h3>
                  <p className="board-column-description text-secondary mb-2">Neue Gruppe anlegen.</p>
                </div>
              </div>

              <div className="board-column-add-visual flex-grow-1 d-flex align-items-center justify-content-center">
                <div className="board-column-add-plus" aria-hidden="true">
                  <i className="bi bi-plus-lg" aria-hidden="true" />
                </div>
              </div>

              <div className="board-group-empty text-secondary small mb-0">Tippe, um eine Gruppe zu erstellen.</div>
            </div>
          </button>
        </div>
      )}
    </section>
  )
}

function BoardGroupView(props: {
  group: BoardGroup
  onOpenNote: (noteId: string) => void
  onTogglePlayback: (id: string, url: string) => void
  currentlyPlayingId: string
  selectedNoteId: string
  onEditGroup: (group: BoardGroup) => void
}) {
  const { group } = props
  const typeCounts = group.notes.reduce<Record<NoteCategory, number>>(
    (accumulator, note) => {
      accumulator[note.category] += 1
      return accumulator
    },
    { '': 0, Idea: 0, Task: 0 },
  )
  const typeBadges = (['', 'Idea', 'Task'] as NoteCategory[])
    .map((category) => ({
      category,
      count: typeCounts[category],
      label:
        category === 'Idea'
          ? typeCounts[category] === 1
            ? '1 Idee'
            : `${typeCounts[category]} Ideen`
          : category === 'Task'
            ? typeCounts[category] === 1
              ? '1 To-Do'
              : `${typeCounts[category]} To-Dos`
            : typeCounts[category] === 1
              ? '1 Notiz'
              : `${typeCounts[category]} Notizen`,
    }))
    .filter((item) => item.count > 0)

  return (
    <article className="board-column card border-0 shadow-sm flex-shrink-0">
      <div className="card-body p-3 d-flex flex-column gap-3 h-100">
        <div className="d-flex align-items-start justify-content-between gap-2">
          <div>
            <p className="small text-uppercase text-secondary fw-semibold mb-1">{group.source === 'manual' ? 'Eigene Gruppe' : 'KI-Gruppe'}</p>
            <h3 className="h5 mb-1 board-column-title">{group.title}</h3>
            {group.description ? <p className="board-column-description text-secondary mb-2">{group.description}</p> : null}
            {typeBadges.length > 0 ? (
              <div className="board-group-kinds d-flex flex-wrap gap-1">
                {typeBadges.map((item) => (
                  <span key={`${group.key}-${item.category}`} className="badge rounded-pill board-kind-badge">
                    {item.label}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <div className="d-flex flex-column align-items-end gap-2">
            <span className="badge rounded-pill text-bg-light border text-secondary">{group.notes.length}</span>
            {group.source === 'manual' ? (
              <button className="btn btn-outline-secondary btn-sm board-group-edit-btn" onClick={() => props.onEditGroup(group)} type="button">
                <i className="bi bi-pencil-square me-1" aria-hidden="true" />
                Bearbeiten
              </button>
            ) : (
              <span className="badge rounded-pill border board-group-source-badge">Automatisch</span>
            )}
          </div>
        </div>

        <div className="board-column-body vstack gap-3 flex-grow-1 overflow-auto pe-1">
          {group.notes.length === 0 ? (
            <div className="board-group-empty text-secondary small">Noch leer. Karten kannst du über „Neue Gruppe“ einsortieren.</div>
          ) : (
            group.notes.map((note) => (
              <StickyNoteCard
                key={note.id}
                note={note}
                selected={props.selectedNoteId === note.id}
                compact
                stacked={false}
                floating={false}
                ghost={false}
                onOpen={() => props.onOpenNote(note.id)}
                onTogglePlayback={() => {
                  const audioPath = noteAudioPath(note)
                  if (audioPath) {
                    props.onTogglePlayback(note.id, mediaUrl(audioPath))
                  }
                }}
                playing={props.currentlyPlayingId === note.id}
              />
            ))
          )}
        </div>
      </div>
    </article>
  )
}

function BoardGroupEditorModal(props: {
  mode: 'create' | 'edit'
  draft: BoardGroupEditorDraft
  setDraft: Dispatch<SetStateAction<BoardGroupEditorDraft>>
  notes: NoteNode[]
  groups: BoardGroup[]
  error: string
  onClose: () => void
  onSave: () => void
  saving: boolean
}) {
  const noteAssignments = useMemo(() => {
    const assignments = new Map<string, string>()
    for (const group of props.groups) {
      for (const note of group.notes) {
        if (!assignments.has(note.id)) {
          assignments.set(note.id, group.title)
        }
      }
    }
    return assignments
  }, [props.groups])

  const orderedNotes = useMemo(
    () =>
      [...props.notes].sort((left, right) => {
        const rightTime = new Date(right.updatedAt).getTime()
        const leftTime = new Date(left.updatedAt).getTime()
        return rightTime - leftTime
      }),
    [props.notes],
  )

  const toggleNote = (noteId: string) => {
    props.setDraft((current) => {
      const noteIds = current.noteIds.includes(noteId)
        ? current.noteIds.filter((value) => value !== noteId)
        : [...current.noteIds, noteId]
      return { ...current, noteIds }
    })
  }

  const selectedCount = props.draft.noteIds.length
  const allSelected = orderedNotes.length > 0 && props.draft.noteIds.length === orderedNotes.length

  return (
    <div className="overlay-backdrop overlay-dark" onClick={props.onClose}>
      <div className="modal-panel board-group-panel" onClick={(event) => event.stopPropagation()}>
        <div className="d-flex align-items-start justify-content-between gap-3 mb-3">
          <div>
            <p className="small text-uppercase text-secondary fw-semibold mb-1">{props.mode === 'create' ? 'Neue Gruppe' : 'Gruppe bearbeiten'}</p>
            <h3 className="h4 mb-0">Titel, Beschreibung und Karten</h3>
          </div>
          <button className="btn btn-outline-secondary btn-sm" onClick={props.onClose} type="button">
            Schließen
          </button>
        </div>

        <div className="row g-3">
          <div className="col-12 col-lg-5 d-flex flex-column gap-3">
            <div>
              <label className="form-label small text-muted fw-semibold" htmlFor="board-group-title">
                Gruppentitel
              </label>
              <input
                id="board-group-title"
                className="form-control form-control-lg"
                value={props.draft.title}
                onChange={(event) => props.setDraft((current) => ({ ...current, title: event.target.value }))}
                placeholder="Zum Beispiel Projekt Alpha"
                autoFocus
              />
            </div>

            <div>
              <label className="form-label small text-muted fw-semibold" htmlFor="board-group-description">
                Beschreibungstext
              </label>
              <textarea
                id="board-group-description"
                className="form-control"
                rows={5}
                value={props.draft.description}
                onChange={(event) => props.setDraft((current) => ({ ...current, description: event.target.value }))}
                placeholder="Worum geht es in dieser Gruppe?"
              />
            </div>

            <div className="board-group-meta card border-0 shadow-sm">
              <div className="card-body p-3 d-flex flex-column gap-2">
                <div className="d-flex align-items-center justify-content-between gap-2">
                  <span className="small text-uppercase text-secondary fw-semibold">Ausgewählt</span>
                  <span className="badge rounded-pill text-bg-light border text-secondary">{selectedCount}</span>
                </div>
                <p className="text-secondary mb-0">Wähle die Karten aus, die in dieser Gruppe landen sollen. Beim Speichern werden sie aus anderen Gruppen entfernt.</p>
                {props.error ? <div className="alert alert-danger mb-0 py-2">{props.error}</div> : null}
              </div>
            </div>
          </div>

          <div className="col-12 col-lg-7">
            <div className="board-group-selector card border-0 shadow-sm h-100">
              <div className="card-body p-3 d-flex flex-column gap-3 h-100">
                <div className="d-flex align-items-center justify-content-between gap-2">
                  <div>
                    <p className="small text-uppercase text-secondary fw-semibold mb-1">Karten auswählen</p>
                    <h4 className="h6 mb-0">Notizen für diese Gruppe</h4>
                  </div>
                  <button
                    className="btn btn-outline-secondary btn-sm"
                    type="button"
                    onClick={() =>
                      props.setDraft((current) => ({
                        ...current,
                        noteIds: allSelected ? [] : orderedNotes.map((note) => note.id),
                      }))
                    }
                  >
                    {allSelected ? 'Alle abwählen' : 'Alle auswählen'}
                  </button>
                </div>

                <div className="board-group-note-list vstack gap-2 flex-grow-1 overflow-auto pe-1">
                  {orderedNotes.length === 0 ? (
                    <div className="text-secondary small">Noch keine Notizen vorhanden.</div>
                  ) : (
                    orderedNotes.map((note) => {
                      const selected = props.draft.noteIds.includes(note.id)
                      const currentGroup = noteAssignments.get(note.id)
                      return (
                        <button
                          key={note.id}
                          type="button"
                          className={`board-group-note-option ${selected ? 'active' : ''}`}
                          onClick={() => toggleNote(note.id)}
                        >
                          <div className="board-group-note-option-check" aria-hidden="true">
                            <i className={`bi ${selected ? 'bi-check-lg' : 'bi-plus-lg'}`} />
                          </div>
                          <div className="board-group-note-option-content">
                            <div className="d-flex align-items-start justify-content-between gap-2">
                              <div className="board-group-note-option-title">{noteTitle(note)}</div>
                              <span className="badge rounded-pill board-kind-badge board-kind-badge-light">{categoryLabel(note.category)}</span>
                            </div>
                            <div className="board-group-note-option-summary text-secondary">{noteSummary(note)}</div>
                            <div className="d-flex flex-wrap align-items-center gap-2 mt-1">
                              <span className="badge rounded-pill text-bg-light border text-secondary">{formatRelativeDate(note.updatedAt)}</span>
                              {currentGroup ? <span className="badge rounded-pill border board-group-note-current">Aktuell: {currentGroup}</span> : null}
                            </div>
                          </div>
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="d-flex flex-wrap justify-content-end gap-2 mt-3">
          <button className="btn btn-primary" onClick={props.onSave} type="button" disabled={props.saving || !props.draft.title.trim()}>
            <i className="bi bi-check2-circle me-1" aria-hidden="true" />
            Speichern
          </button>
          <button className="btn btn-outline-secondary" onClick={props.onClose} type="button">
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  )
}

function StickyNoteCard(props: {
  note: NoteNode
  selected: boolean
  compact: boolean
  stacked: boolean
  floating: boolean
  ghost: boolean
  onOpen: () => void
  onOpenDetail?: () => void
  onTogglePlayback: () => void
  playing: boolean
}) {
  const summary = noteSummary(props.note)
  const hasAudio = Boolean(noteAudioPath(props.note))
  const hasTranscript = Boolean(safeText(props.note.rawTranscript).trim())
  const isExpanded = !props.stacked || props.selected
  const openTranscriptTarget = props.onOpenDetail ?? props.onOpen
  const noteClasses = [
    'sticky-note-card',
    categoryThemeClass(props.note.category),
    props.compact ? 'sticky-note-card-compact' : '',
    props.stacked ? 'sticky-note-card-stacked' : '',
    props.floating ? 'sticky-note-card-floating' : '',
    props.ghost ? 'sticky-note-card-ghost' : '',
    props.selected ? 'selected' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <article
      className={noteClasses}
      role="button"
      tabIndex={0}
      aria-expanded={isExpanded}
      onClick={props.onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          props.onOpen()
        }
      }}
    >
      <h3 className="sticky-note-title mb-1">{noteTitle(props.note)}</h3>
      <div className="sticky-note-kind text-uppercase small fw-semibold">{categoryLabel(props.note.category)}</div>
      {isExpanded ? (
        <>
          <p className="sticky-note-summary mb-0">{summary}</p>

          <div className="sticky-note-actions d-flex gap-2 mt-3">
            <button
              className="btn btn-sm btn-light flex-grow-1 sticky-note-action-button"
              onClick={(event) => {
                event.stopPropagation()
                if (hasAudio) {
                  props.onTogglePlayback()
                }
              }}
              type="button"
              disabled={!hasAudio}
              aria-label={hasAudio ? (props.playing ? 'Audio anhalten' : 'Audio abspielen') : 'Keine Audio verfügbar'}
            >
              <i className={`bi ${props.playing ? 'bi-pause-fill' : 'bi-play-fill'} me-1`} aria-hidden="true" />
              {hasAudio ? (props.playing ? 'Pause' : 'Audio') : 'Keine Audio'}
            </button>

            <button
              className="btn btn-sm btn-outline-light flex-grow-1 sticky-note-action-button"
              onClick={(event) => {
                event.stopPropagation()
                if (hasTranscript) {
                  openTranscriptTarget()
                }
              }}
              type="button"
              disabled={!hasTranscript}
              aria-label={hasTranscript ? 'Rohes Transkript anzeigen' : 'Kein Transkript verfügbar'}
            >
              <i className="bi bi-file-text me-1" aria-hidden="true" />
              Transkript
            </button>
          </div>

          {props.onOpenDetail ? (
            <button
              className="btn btn-sm btn-outline-light sticky-note-detail-button mt-1"
              onClick={(event) => {
                event.stopPropagation()
                props.onOpenDetail?.()
              }}
              type="button"
            >
              <i className="bi bi-arrows-angle-expand me-1" aria-hidden="true" />
              Detail öffnen
            </button>
          ) : null}
        </>
      ) : null}
    </article>
  )
}

function NoteDetailPage(props: {
  note: NoteNode
  onClose: () => void
  onDeleteNote: () => void
  onTogglePlayback: (noteId: string, url: string) => void
  onChangeCategory: (category: NoteCategory) => Promise<void>
  onRebuildNote: () => void
  onReanalyzeCategory: () => void
  onUpdateTranscript: (transcript: string) => Promise<void>
}) {
  const note = props.note
  const [categoryDraft, setCategoryDraft] = useState<NoteCategory>(note.category)
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false)
  const [transcriptEditorOpen, setTranscriptEditorOpen] = useState(false)
  const [transcriptDraft, setTranscriptDraft] = useState(note.rawTranscript)
  const [transcriptEditorError, setTranscriptEditorError] = useState('')
  const audioPath = noteAudioPath(note)
  const hasAudio = Boolean(audioPath)

  useEffect(() => {
    setCategoryDraft(note.category)
    setTranscriptOpen(false)
    setCategoryPickerOpen(false)
    setTranscriptEditorOpen(false)
    setTranscriptDraft(note.rawTranscript)
    setTranscriptEditorError('')
  }, [note.category, note.id, note.rawTranscript])

  const detailNoteClasses = ['detail-note-surface', categoryThemeClass(note.category)].join(' ')

  return (
    <section className={`note-detail-page h-100 d-flex flex-column ${detailNoteClasses}`}>
      <div className="note-detail-topbar d-flex align-items-center justify-content-between gap-3 mb-3">
        <button className="btn btn-sm btn-outline-light detail-topback" onClick={props.onClose} type="button">
          <i className="bi bi-arrow-left me-1" aria-hidden="true" />
          Zurück
        </button>
        <span className="badge rounded-pill text-bg-light text-dark detail-category-badge">{categoryLabel(note.category)}</span>
      </div>

      <div className="detail-note-card vstack gap-3 flex-grow-1">
        <header className="detail-title-block">
          <p className="detail-label text-uppercase small fw-semibold mb-1">Überschrift</p>
          <h2 className="detail-note-title mb-0">{noteTitle(note)}</h2>
        </header>

        <article className="detail-summary-block">
          <p className="detail-label text-uppercase small fw-semibold mb-2">Zusammenfassung</p>
          <p className="detail-summary-text mb-0">{note.summary || 'Noch keine Zusammenfassung vorhanden.'}</p>
        </article>

        <div className="detail-audio-block">
          <button
            className="btn btn-light detail-action-btn"
            onClick={() => props.onTogglePlayback(note.id, mediaUrl(audioPath))}
            type="button"
            disabled={!hasAudio}
          >
            <i className={`bi ${hasAudio ? 'bi-play-fill' : 'bi-mic-mute-fill'} me-1`} aria-hidden="true" />
            {hasAudio ? 'Audio abspielen' : 'Keine Audioaufnahme'}
          </button>
        </div>

        {note.rawTranscript ? (
          <article className="detail-transcript-block vstack gap-2">
            <div className="d-flex align-items-center justify-content-between gap-2">
            <button
              className="detail-transcript-toggle btn btn-sm btn-link p-0 text-start"
              type="button"
              onClick={() => setTranscriptOpen((current) => !current)}
              aria-expanded={transcriptOpen}
            >
              <i className={`bi ${transcriptOpen ? 'bi-chevron-down' : 'bi-chevron-right'} me-1`} aria-hidden="true" />
              Transkript
            </button>
            <button className="btn btn-sm btn-outline-light detail-transcript-edit-btn" type="button" onClick={() => setTranscriptEditorOpen(true)}>
              <i className="bi bi-pencil-square me-1" aria-hidden="true" />
              Edit
            </button>
            </div>
            {transcriptOpen ? <div className="detail-transcript-body">{note.rawTranscript}</div> : null}
          </article>
        ) : null}

        <div className="detail-actions vstack gap-2 mt-auto">
          <button className="btn btn-light detail-action-btn" onClick={() => setTranscriptEditorOpen(true)} type="button" disabled={!note.rawTranscript.trim()}>
            Transkript bearbeiten
          </button>
          <button className="btn btn-light detail-action-btn" onClick={() => setCategoryPickerOpen(true)} type="button">
            Kategorie ändern
          </button>
          <button className="btn btn-light detail-action-btn" onClick={props.onReanalyzeCategory} type="button">
            Kategorie neu ermitteln
          </button>
          <button className="btn btn-light detail-action-btn" onClick={props.onRebuildNote} type="button">
            Neu zusammenfassen und neu transkribieren
          </button>
          <button className="btn btn-outline-light detail-action-btn" onClick={props.onDeleteNote} type="button">
            Löschen
          </button>
        </div>
      </div>

      {categoryPickerOpen ? (
        <CategoryPickerModal
          currentCategory={categoryDraft}
          onClose={() => setCategoryPickerOpen(false)}
          onSelect={async (category) => {
            setCategoryDraft(category)
            await props.onChangeCategory(category)
            setCategoryPickerOpen(false)
          }}
        />
      ) : null}

      {transcriptEditorOpen ? (
        <TranscriptEditorModal
          transcriptDraft={transcriptDraft}
          setTranscriptDraft={setTranscriptDraft}
          error={transcriptEditorError}
          onClose={() => setTranscriptEditorOpen(false)}
          onSave={async () => {
            const clean = transcriptDraft.trim()
            if (!clean) {
              setTranscriptEditorError('Bitte einen Transkripttext eingeben.')
              return
            }
            setTranscriptEditorError('')
            try {
              await props.onUpdateTranscript(clean)
              setTranscriptEditorOpen(false)
            } catch (error) {
              setTranscriptEditorError(error instanceof Error ? error.message : 'Das Transkript konnte nicht gespeichert werden.')
            }
          }}
        />
      ) : null}
    </section>
  )
}

function TranscriptEditorModal(props: {
  transcriptDraft: string
  setTranscriptDraft: Dispatch<SetStateAction<string>>
  error: string
  onClose: () => void
  onSave: () => Promise<void>
}) {
  return (
    <div className="overlay-backdrop overlay-dark" onClick={props.onClose}>
      <div className="modal-panel transcript-editor-panel" onClick={(event) => event.stopPropagation()}>
        <div className="d-flex align-items-start justify-content-between gap-3 mb-3">
          <div>
            <p className="small text-uppercase text-secondary fw-semibold mb-1">Transkript</p>
            <h3 className="h4 mb-0">Text korrigieren</h3>
          </div>
          <button className="btn btn-outline-secondary btn-sm" onClick={props.onClose} type="button">
            Schließen
          </button>
        </div>

        <p className="text-secondary mb-3">Hier kannst du Transkriptfehler direkt ändern. Danach wird die Zusammenfassung neu berechnet.</p>

        <textarea
          className="form-control transcript-editor-textarea"
          rows={14}
          value={props.transcriptDraft}
          onChange={(event) => props.setTranscriptDraft(event.target.value)}
          placeholder="Transkript hier korrigieren …"
          autoFocus
        />

        {props.error ? <div className="alert alert-danger mt-3 mb-0 py-2">{props.error}</div> : null}

        <div className="d-flex flex-wrap justify-content-end gap-2 mt-3">
          <button className="btn btn-primary" onClick={() => void props.onSave()} type="button">
            Speichern
          </button>
          <button className="btn btn-outline-secondary" onClick={props.onClose} type="button">
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  )
}

function CategoryPickerModal(props: {
  currentCategory: NoteCategory
  onClose: () => void
  onSelect: (category: NoteCategory) => Promise<void>
}) {
  return (
    <div className="overlay-backdrop overlay-dark" onClick={props.onClose}>
      <div className="modal-panel category-panel" onClick={(event) => event.stopPropagation()}>
        <div className="category-panel-header d-flex align-items-start justify-content-between gap-3">
          <div>
            <p className="small text-uppercase text-secondary fw-semibold mb-1">Kategorie</p>
            <h3 className="h5 mb-0">Kategorie auswählen</h3>
          </div>
          <button className="btn btn-outline-secondary btn-sm" onClick={props.onClose} type="button">
            Schließen
          </button>
        </div>

        <div className="category-panel-grid detail-type-grid detail-type-grid-modal" role="radiogroup" aria-label="Kategorie auswählen">
          {noteCategoryOptions.map((option) => {
            const selected = props.currentCategory === option.value
            return (
              <button
                key={option.label}
              type="button"
              className={`detail-type-option detail-type-option-modal ${selected ? 'active' : ''}`}
              aria-pressed={selected}
              onClick={() => void props.onSelect(option.value)}
            >
                <span className={`detail-type-swatch ${option.themeClass} ${selected ? 'active' : ''}`} aria-hidden="true" />
                <span className="detail-type-content">
                  <span className="detail-type-title">{option.label}</span>
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function SettingsModal(props: {
  settings: SettingsResponse
  settingsDraft: SettingsDraft
  setSettingsDraft: Dispatch<SetStateAction<SettingsDraft>>
  onClose: () => void
  onSave: () => void
  onExportTechnicalReport: () => void
  reportStatus: string
  reportDownload: string
  routineStatus: string
  onRunAllNotesRoutine: () => void
  onRunAllNotesTranscriptRoutine: () => void
  onRunBoardGroupingRoutine: () => void
  onDeleteAllNotes: () => void
  onRefreshLlmLogs: () => void
  llmLogs: LlmLogEntry[]
  llmLogsLoading: boolean
  llmLogsError: string
}) {
  const formatMessage = (text: string): string => {
    const clean = text.trim()
    return clean || '(leer)'
  }

  return (
    <div className="overlay-backdrop" onClick={props.onClose}>
      <div className="modal-panel settings-panel" onClick={(event) => event.stopPropagation()}>
        <div className="d-flex align-items-start justify-content-between gap-3 mb-3">
          <div>
            <p className="small text-uppercase text-secondary fw-semibold mb-1">Setup</p>
            <h3 className="h4 mb-0">Technik bleibt im Hintergrund</h3>
          </div>
          <button className="btn btn-outline-secondary btn-sm" onClick={props.onClose} type="button">
            Schließen
          </button>
        </div>

        <p className="text-secondary mb-4">Die Felder bleiben direkt editierbar, damit der Flow auf Voice und Notizen fokussiert bleibt.</p>

        <div className="row g-3">
          <div className="col-12">
            <div className="input-group">
              <span className="input-group-text">OpenAI API Key</span>
              <input
                id="settings-api-key"
                className="form-control"
                type="password"
                value={props.settingsDraft.openAiApiKey}
                placeholder={props.settings.openAiApiKeyPresent ? 'Vorhandener Key bleibt erhalten' : 'Neuen API-Key setzen'}
                onChange={(event) => props.setSettingsDraft((current) => ({ ...current, openAiApiKey: event.target.value }))}
              />
            </div>
          </div>

          <div className="col-12 col-md-6">
            <div className="input-group">
              <span className="input-group-text">OpenAI Model</span>
              <input
                id="settings-openai-model"
                className="form-control"
                value={props.settingsDraft.openAiModel}
                onChange={(event) => props.setSettingsDraft((current) => ({ ...current, openAiModel: event.target.value }))}
              />
            </div>
          </div>

          <div className="col-12 col-md-6">
            <div className="input-group">
              <span className="input-group-text">Sprache</span>
              <input
                id="settings-language"
                className="form-control"
                value={props.settingsDraft.language}
                onChange={(event) => props.setSettingsDraft((current) => ({ ...current, language: event.target.value }))}
              />
            </div>
          </div>

          <div className="col-12 col-md-6">
            <div className="input-group">
              <span className="input-group-text">Transcription Model</span>
              <input
                id="settings-transcription-model"
                className="form-control"
                value={props.settingsDraft.transcriptionModel}
                onChange={(event) => props.setSettingsDraft((current) => ({ ...current, transcriptionModel: event.target.value }))}
              />
            </div>
          </div>

          <div className="col-12">
            <label className="form-label fw-semibold" htmlFor="settings-transcription-prompt">
              Transkriptions-Prompt
            </label>
            <textarea
              id="settings-transcription-prompt"
              className="form-control"
              rows={6}
              value={props.settingsDraft.transcriptionPrompt}
              onChange={(event) => props.setSettingsDraft((current) => ({ ...current, transcriptionPrompt: event.target.value }))}
              placeholder="Prompt für die Spracherkennung …"
            />
            <div className="form-text">
              Hilfreich für Namen, Fachbegriffe, Satzzeichen und den gewünschten Stil. Je konkreter der Prompt, desto stabiler wird das Ergebnis.
            </div>
          </div>

          <div className="col-12 col-md-6">
            <div className="input-group">
              <span className="input-group-text">Summary Model</span>
              <input
                id="settings-summary-model"
                className="form-control"
                value={props.settingsDraft.summaryModel}
                onChange={(event) => props.setSettingsDraft((current) => ({ ...current, summaryModel: event.target.value }))}
              />
            </div>
          </div>

          <div className="col-12">
            <label className="form-label fw-semibold" htmlFor="settings-summary-prefix">
              Transkript-Zusammenfassungs-Prompt
            </label>
            <textarea
              id="settings-summary-prefix"
              className="form-control"
              rows={7}
              value={props.settingsDraft.summaryPromptPrefix}
              onChange={(event) => props.setSettingsDraft((current) => ({ ...current, summaryPromptPrefix: event.target.value }))}
              placeholder="Prompt für die Transkript-Zusammenfassung …"
            />
            <div className="form-text">
              Dieser Prompt steuert, wie aus einem Transkript eine kurze Überschrift und ein klarer Fließtext erzeugt werden.
            </div>
          </div>

          <div className="col-12">
            <label className="form-label fw-semibold" htmlFor="settings-category-prefix">
              Kategorie-Vortext
            </label>
            <textarea
              id="settings-category-prefix"
              className="form-control"
              rows={5}
              value={props.settingsDraft.categoryPromptPrefix}
              onChange={(event) => props.setSettingsDraft((current) => ({ ...current, categoryPromptPrefix: event.target.value }))}
              placeholder="Vortext für die KI-Kategorisierung …"
            />
            <div className="form-text">Dieser Text wird der KI zusammen mit der Zusammenfassung übergeben.</div>
          </div>

          <div className="col-12">
            <label className="form-label fw-semibold" htmlFor="settings-group-prefix">
              Gruppierungs-Prompt
            </label>
            <textarea
              id="settings-group-prefix"
              className="form-control"
              rows={5}
              value={props.settingsDraft.groupPromptPrefix}
              onChange={(event) => props.setSettingsDraft((current) => ({ ...current, groupPromptPrefix: event.target.value }))}
              placeholder="Prompt für die KI-Gruppierung …"
            />
            <div className="form-text">Dieser Prompt steuert, wie die KI aus allen Notizen thematische Board-Spalten bildet.</div>
          </div>

        </div>

        <div className="d-flex flex-wrap gap-2 mt-4">
          <button className="btn btn-primary" onClick={props.onSave} type="button">
            Speichern
          </button>
          <button className="btn btn-outline-primary" onClick={props.onRunAllNotesRoutine} type="button">
            Kategorien neu erstellen
          </button>
          <button className="btn btn-outline-primary" onClick={props.onRunAllNotesTranscriptRoutine} type="button">
            Transkripte neu erstellen
          </button>
          <button className="btn btn-outline-primary" onClick={props.onRunBoardGroupingRoutine} type="button">
            Gruppen neu erstellen
          </button>
          <button className="btn btn-outline-primary" onClick={props.onExportTechnicalReport} type="button">
            Tech-Report exportieren
          </button>
          <button className="btn btn-outline-danger" onClick={props.onDeleteAllNotes} type="button">
            Alle Notizen löschen
          </button>
        </div>

        {props.routineStatus && <div className="alert alert-info mt-4 mb-0">{props.routineStatus}</div>}
        {props.reportStatus && <div className="alert alert-info mt-4 mb-0">{props.reportStatus}</div>}
        {props.reportDownload && <div className="small text-secondary mt-2">Zuletzt exportiert: {props.reportDownload}</div>}

        <div className="mt-4">
          <div className="d-flex flex-wrap align-items-start justify-content-between gap-2 mb-3">
            <div>
              <p className="small text-uppercase text-secondary fw-semibold mb-1">Protokoll</p>
              <h4 className="h6 mb-0">LLM-Verlauf</h4>
              <div className="small text-secondary">Alle KI-Anfragen mit Antwort oder Fehler.</div>
            </div>
            <button className="btn btn-outline-secondary btn-sm" onClick={props.onRefreshLlmLogs} type="button">
              Aktualisieren
            </button>
          </div>

          <div className="llm-log-stream">
            {props.llmLogsLoading ? (
              <div className="text-secondary small py-3">LLM-Protokoll wird geladen …</div>
            ) : props.llmLogsError ? (
              <div className="alert alert-warning mb-0">{props.llmLogsError}</div>
            ) : props.llmLogs.length === 0 ? (
              <div className="llm-log-empty text-secondary">Noch keine LLM-Interaktionen protokolliert.</div>
            ) : (
              props.llmLogs.map((entry) => (
                <div key={entry.id} className="llm-log-card">
                  <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-2">
                    <div className="fw-semibold">{entry.kind}</div>
                    <div className="small text-secondary">{formatRelativeDate(entry.createdAt)}</div>
                  </div>
                  <div className="small text-secondary mb-2">
                    {entry.provider} · {entry.model}
                    {entry.noteTitle ? ` · ${entry.noteTitle}` : ''}
                  </div>

                  <div className="llm-chat-thread">
                    {entry.messages.map((message, index) => (
                      <div key={`${entry.id}-${index}`} className={`llm-chat-row llm-chat-row-${message.role}`}>
                        <div className="llm-chat-meta">{message.role}</div>
                        <div className={`llm-chat-bubble llm-chat-bubble-${message.role}`}>{formatMessage(message.content)}</div>
                      </div>
                    ))}

                    {entry.response && (
                      <div className="llm-chat-row llm-chat-row-assistant">
                        <div className="llm-chat-meta">assistant</div>
                        <div className="llm-chat-bubble llm-chat-bubble-assistant">{formatMessage(entry.response)}</div>
                      </div>
                    )}

                    {entry.error && (
                      <div className="llm-chat-row llm-chat-row-meta">
                        <div className="llm-chat-meta">meta</div>
                        <div className="llm-chat-bubble llm-chat-bubble-error">{formatMessage(entry.error)}</div>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function LoadingOverlay(props: { message: string }) {
  return (
    <div className="overlay-backdrop overlay-dark">
      <div className="modal-panel loading-panel text-center">
        <div className="spinner-border text-primary mb-3" role="status" aria-hidden="true" />
        <p className="mb-0 fw-semibold">{props.message}</p>
      </div>
    </div>
  )
}

function ErrorOverlay(props: { message: string; onDismiss: () => void }) {
  return (
    <div className="overlay-backdrop overlay-dark">
      <div className="modal-panel loading-panel text-center">
        <div className="display-6 text-danger fw-bold mb-2">!</div>
        <h3 className="h5">Etwas hat nicht geklappt</h3>
        <p className="text-secondary">{props.message}</p>
        <button className="btn btn-primary" onClick={props.onDismiss} type="button">
          Verstanden
        </button>
      </div>
    </div>
  )
}

function ConfirmationModal(props: {
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="overlay-backdrop overlay-dark">
      <div className="modal-panel confirm-panel">
        <h3 className="h5">{props.title}</h3>
        <p className="text-secondary">{props.message}</p>
        <div className="d-flex flex-wrap gap-2">
          <button className={props.destructive ? 'btn btn-danger' : 'btn btn-primary'} onClick={props.onConfirm} type="button">
            {props.confirmLabel}
          </button>
          <button className="btn btn-outline-secondary" onClick={props.onCancel} type="button">
            {props.cancelLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function TextNoteModal(props: {
  noteDraft: string
  setNoteDraft: (value: string) => void
  onSubmit: () => void
  onClose: () => void
  submitting: boolean
}) {
  return (
    <div className="overlay-backdrop overlay-dark">
      <div className="modal-panel text-note-panel">
        <div className="d-flex align-items-start justify-content-between gap-3 mb-3">
          <div>
            <p className="small text-uppercase text-secondary fw-semibold mb-1">Textnotiz</p>
            <h3 className="h5 mb-0">Notiz schreiben</h3>
          </div>
          <button className="btn btn-outline-secondary btn-sm" onClick={props.onClose} type="button">
            Schließen
          </button>
        </div>

        <label className="form-label small text-muted fw-semibold" htmlFor="text-note-modal-input">
          Was möchtest du festhalten?
        </label>
        <textarea
          id="text-note-modal-input"
          className="form-control form-control-lg mb-3"
          rows={7}
          value={props.noteDraft}
          onChange={(event) => props.setNoteDraft(event.target.value)}
          placeholder="Idee, Aufgabe oder Beobachtung notieren …"
          autoFocus
        />

        <div className="d-flex flex-wrap gap-2">
          <button className="btn btn-primary flex-grow-1" onClick={props.onSubmit} type="button" disabled={props.submitting || !props.noteDraft.trim()}>
            <i className="bi bi-send-fill me-1" aria-hidden="true" />
            Speichern
          </button>
          <button className="btn btn-outline-secondary" onClick={props.onClose} type="button">
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  )
}

function RecordingOverlay(props: { levels: number[]; onStop: () => void }) {
  return (
    <div className="overlay-backdrop recording-backdrop">
      <div className="recording-panel modal-panel text-center">
        <p className="small text-uppercase text-secondary fw-semibold mb-1">Aufnahme läuft</p>
        <h3 className="h5 mb-3">Live-Equalizer</h3>
        <div className="recording-equalizer" aria-hidden="true">
          {Array.from({ length: 24 }).map((_, index) => {
            const level = props.levels[index] ?? props.levels[props.levels.length - 1] ?? 0.08
            return <span key={index} style={{ height: `${Math.max(16, Math.round(level * 100))}%` }} />
          })}
        </div>
        <button className="btn btn-danger btn-lg rounded-pill recording-stop-btn" onClick={props.onStop} type="button">
          <i className="bi bi-stop-fill me-2" aria-hidden="true" />
          Aufnahme stoppen
        </button>
        <p className="small text-secondary mb-0 mt-3">Sprich einfach weiter. Die Aufnahme endet erst, wenn du auf Stop tippst.</p>
      </div>
    </div>
  )
}
