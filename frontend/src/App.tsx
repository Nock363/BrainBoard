import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { api, mediaUrl } from './api'
import { useVoiceRecorder } from './hooks/useVoiceRecorder'
import type { NoteCategory, NoteNode, SettingsResponse, TabKey } from './types'

type BusyState = { message: string } | null

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
}

type BoardColumn = {
  key: string
  label: string
  notes: NoteNode[]
  kind: 'idea' | 'task' | 'neutral'
}

const tabs: Array<{ key: TabKey; label: string; icon: string }> = [
  { key: 'capture', label: 'Start', icon: 'bi-stars' },
  { key: 'inbox', label: 'Eingang', icon: 'bi-inbox-fill' },
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
  return 'Keins davon'
}

function categoryThemeClass(category: NoteCategory): string {
  if (category === 'Idea') return 'sticky-note-idea'
  if (category === 'Task') return 'sticky-note-task'
  return 'sticky-note-neutral'
}

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

function getBoardColumns(notes: NoteNode[]): BoardColumn[] {
  const ideaNotes: NoteNode[] = []
  const taskNotes: NoteNode[] = []
  const neutralNotes: NoteNode[] = []

  for (const note of notes) {
    if (note.category === 'Idea') ideaNotes.push(note)
    else if (note.category === 'Task') taskNotes.push(note)
    else neutralNotes.push(note)
  }

  const columns: BoardColumn[] = [
    { key: 'idea', label: 'Ideen', notes: ideaNotes, kind: 'idea' },
    { key: 'task', label: 'To-Dos', notes: taskNotes, kind: 'task' },
    { key: 'neutral', label: 'Keins davon', notes: neutralNotes, kind: 'neutral' },
  ]

  return columns
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('capture')
  const [notes, setNotes] = useState<NoteNode[]>([])
  const [settings, setSettings] = useState<SettingsResponse | null>(null)
  const [selectedNoteId, setSelectedNoteId] = useState('')
  const [noteDraft, setNoteDraft] = useState('')
  const [textNoteOpen, setTextNoteOpen] = useState(false)
  const [busy, setBusy] = useState<BusyState>(null)
  const [error, setError] = useState('')
  const [playingId, setPlayingId] = useState('')
  const [deleteNoteTarget, setDeleteNoteTarget] = useState<NoteNode | null>(null)
  const [deleteAllOpen, setDeleteAllOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [routineStatus, setRoutineStatus] = useState('')
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft>({
    openAiApiKey: '',
    openAiModel: '',
    transcriptionModel: '',
    summaryModel: '',
    followUpModel: '',
    language: '',
  })
  const [reportStatus, setReportStatus] = useState('')
  const [reportDownload, setReportDownload] = useState('')

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
    return (candidate.tab === 'capture' || candidate.tab === 'inbox' || candidate.tab === 'board') && typeof candidate.selectedNoteId === 'string'
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
  const boardColumns = useMemo(() => getBoardColumns(notes), [notes])

  const reloadNotes = async () => {
    const response = await api.listNotes()
    setNotes(response.notes)
    if (selectedNoteId && !response.notes.some((note) => note.id === selectedNoteId)) {
      setSelectedNoteId('')
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
    })
    return response
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
    const response = await runBusy('Alle Notizen werden neu analysiert …', async () => api.reanalyzeAllNotes())
    await reloadNotes()
    setRoutineStatus(`Routine abgeschlossen: ${response.updatedNotes} Notizen aktualisiert${response.skippedNotes ? `, ${response.skippedNotes} übersprungen` : ''}`)
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
    const response = await runBusy('Klasse wird geändert …', async () => api.updateNoteCategory(selectedNote.id, category))
    await updateNotesFromResponse(response)
  }

  const deleteAllNotes = async () => {
    await runBusy('Alle Notizen werden gelöscht …', async () => api.deleteAllNotes())
    setDeleteAllOpen(false)
    setSelectedNoteId('')
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
    }))
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
              onChangeCategory={(category) => void changeSelectedNoteCategory(category)}
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
                selectedNoteId={selectedNoteId}
                onOpenNote={openNoteDetail}
                onTogglePlayback={(id, url) => void playAudio(id, url)}
                currentlyPlayingId={playingId}
              />
            </section>

              <section className="page-panel h-100 d-flex flex-column gap-3">
                <BoardView
                  columns={boardColumns}
                  selectedNoteId={selectedNoteId}
                  onOpenNote={openNoteDetail}
                  onTogglePlayback={(id, url) => void playAudio(id, url)}
                  currentlyPlayingId={playingId}
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
            onDeleteAllNotes={() => setDeleteAllOpen(true)}
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

function InboxView(props: {
  notes: NoteNode[]
  selectedNoteId: string
  onOpenNote: (noteId: string) => void
  onTogglePlayback: (id: string, url: string) => void
  currentlyPlayingId: string
}) {
  return (
    <section className="inbox-view h-100 d-flex flex-column gap-3">
      <div className="card border-0 shadow-sm">
        <div className="card-body p-3 p-lg-4 d-flex flex-column gap-2">
          <div className="d-flex align-items-start justify-content-between gap-3">
            <div>
              <p className="small text-uppercase text-secondary fw-semibold mb-1">Eingang</p>
              <h2 className="h3 mb-0">Post-its</h2>
            </div>
            <span className="badge rounded-pill text-bg-light border text-secondary">{props.notes.length}</span>
          </div>
          <p className="text-secondary mb-0">Jedes Post-it zeigt nur die Zusammenfassung und zwei Aktionen: Audio und Transkript.</p>
        </div>
      </div>

      {props.notes.length === 0 ? (
        <div className="alert alert-light border shadow-sm mb-0">Noch keine Notizen vorhanden. Starte eine Sprachnotiz oder lege Text direkt an.</div>
      ) : (
        <div className="inbox-list vstack gap-3 flex-grow-1">
          {props.notes.map((note) => (
            <StickyNoteCard
              key={note.id}
              note={note}
              selected={props.selectedNoteId === note.id}
              compact={false}
              onOpen={() => props.onOpenNote(note.id)}
              onTogglePlayback={() => {
                const audioPath = noteAudioPath(note)
                if (audioPath) {
                  props.onTogglePlayback(note.id, mediaUrl(audioPath))
                }
              }}
              playing={props.currentlyPlayingId === note.id}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function BoardView(props: {
  columns: BoardColumn[]
  selectedNoteId: string
  onOpenNote: (noteId: string) => void
  onTogglePlayback: (id: string, url: string) => void
  currentlyPlayingId: string
}) {
  const hasNotes = props.columns.some((column) => column.notes.length > 0)

  return (
    <section className="board-view h-100 d-flex flex-column gap-3">
      <div className="card border-0 shadow-sm">
        <div className="card-body p-3 p-lg-4 d-flex flex-column gap-2">
          <div className="d-flex align-items-start justify-content-between gap-3">
            <div>
              <p className="small text-uppercase text-secondary fw-semibold mb-1">Board</p>
              <h2 className="h3 mb-0">Kanban-Ordnung</h2>
            </div>
            <span className="badge rounded-pill text-bg-light border text-secondary">{props.columns.reduce((count, column) => count + column.notes.length, 0)}</span>
          </div>
          <p className="text-secondary mb-0">Die Karten bleiben bewusst minimal: Summary plus Audio und Transkript.</p>
        </div>
      </div>

      {!hasNotes ? (
        <div className="alert alert-light border shadow-sm mb-0">Noch keine kategorisierten Notizen vorhanden. Neue Notizen bleiben erst einmal weiß, bis die KI eine Kategorie erkennt.</div>
      ) : (
        <div className="board-row flex-grow-1 d-flex gap-3 overflow-auto pb-2">
          {props.columns.map((column) => (
            <BoardColumnView
              key={column.key}
              column={column}
              onOpenNote={props.onOpenNote}
              onTogglePlayback={props.onTogglePlayback}
              currentlyPlayingId={props.currentlyPlayingId}
              selectedNoteId={props.selectedNoteId}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function BoardColumnView(props: {
  column: BoardColumn
  onOpenNote: (noteId: string) => void
  onTogglePlayback: (id: string, url: string) => void
  currentlyPlayingId: string
  selectedNoteId: string
}) {
  const { column } = props
  const toneLabel = column.kind === 'idea' ? 'Idee' : column.kind === 'task' ? 'Aufgabe' : 'Keins davon'

  return (
    <article className="board-column card border-0 shadow-sm flex-shrink-0">
      <div className="card-body p-3 d-flex flex-column gap-3 h-100">
        <div className="d-flex align-items-start justify-content-between gap-2">
          <div>
            <p className="small text-uppercase text-secondary fw-semibold mb-1">{toneLabel}</p>
            <h3 className="h5 mb-0 board-column-title">{column.label}</h3>
          </div>
          <span className="badge rounded-pill text-bg-light border text-secondary">{column.notes.length}</span>
        </div>

        <div className="board-column-body vstack gap-3 flex-grow-1 overflow-auto pe-1">
          {column.notes.length === 0 ? (
            <div className="text-secondary small">Noch leer.</div>
          ) : (
            column.notes.map((note) => (
              <StickyNoteCard
                key={note.id}
                note={note}
                selected={props.selectedNoteId === note.id}
                compact
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

function StickyNoteCard(props: {
  note: NoteNode
  selected: boolean
  compact: boolean
  onOpen: () => void
  onTogglePlayback: () => void
  playing: boolean
}) {
  const summary = noteSummary(props.note)
  const hasAudio = Boolean(noteAudioPath(props.note))
  const hasTranscript = Boolean(safeText(props.note.rawTranscript).trim())
  const noteClasses = ['sticky-note-card', categoryThemeClass(props.note.category), props.compact ? 'sticky-note-card-compact' : '', props.selected ? 'selected' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <article className={noteClasses} role="button" tabIndex={0} onClick={props.onOpen} onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        props.onOpen()
      }
    }}>
      <div className="sticky-note-kind text-uppercase small fw-semibold">{categoryLabel(props.note.category)}</div>
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
              props.onOpen()
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
    </article>
  )
}

function NoteDetailPage(props: {
  note: NoteNode
  onClose: () => void
  onDeleteNote: () => void
  onChangeCategory: (category: NoteCategory) => void
}) {
  const note = props.note
  const [categoryDraft, setCategoryDraft] = useState<NoteCategory>(note.category)

  useEffect(() => {
    setCategoryDraft(note.category)
  }, [note.category, note.id])

  return (
    <section className="note-detail-page h-100 d-flex flex-column gap-3">
      <div className="card border-0 shadow-sm">
        <div className="card-body p-3 p-lg-4 d-flex flex-column flex-lg-row align-items-start justify-content-between gap-3">
          <div>
            <p className="small text-uppercase text-secondary fw-semibold mb-1">Notiz</p>
            <h2 className="h3 mb-1">Zusammenfassung</h2>
            <p className="text-secondary mb-0">Die Seite zeigt nur noch das Wesentliche.</p>
          </div>
          <div className="d-flex flex-column flex-sm-row flex-wrap align-items-sm-end gap-2 justify-content-end">
            <div className="d-flex flex-column gap-1">
              <label className="form-label small text-uppercase text-secondary fw-semibold mb-0" htmlFor="note-category-select">
                Klasse ändern
              </label>
              <select
                id="note-category-select"
                className="form-select form-select-sm"
                value={categoryDraft}
                onChange={(event) => {
                  const nextCategory = event.target.value as NoteCategory
                  setCategoryDraft(nextCategory)
                  props.onChangeCategory(nextCategory)
                }}
              >
                <option value="">Keins davon</option>
                <option value="Idea">Idee</option>
                <option value="Task">To-Do</option>
              </select>
            </div>
            <button className="btn btn-outline-secondary btn-sm" onClick={props.onClose} type="button">
              <i className="bi bi-arrow-left me-1" aria-hidden="true" />
              Zurück
            </button>
            <button className="btn btn-outline-danger btn-sm" onClick={props.onDeleteNote} type="button">
              <i className="bi bi-trash3-fill me-1" aria-hidden="true" />
              Löschen
            </button>
          </div>
        </div>
      </div>

      <div className="note-detail-scroll vstack gap-3 flex-grow-1 overflow-auto pb-2">
        <article className={`sticky-note-card ${categoryThemeClass(note.category)} detail-sticky-note`}>
          <p className="sticky-note-summary mb-0">{note.summary || 'Noch keine Zusammenfassung vorhanden.'}</p>
        </article>

        {note.rawTranscript ? (
          <article className="card border-0 shadow-sm">
            <div className="card-body p-3 p-lg-4 vstack gap-2">
              <h3 className="h5 mb-0">Transkript</h3>
              <div className="transcript-box mt-1">{note.rawTranscript}</div>
            </div>
          </article>
        ) : null}
      </div>
    </section>
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
  onDeleteAllNotes: () => void
}) {
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

        </div>

        <div className="d-flex flex-wrap gap-2 mt-4">
          <button className="btn btn-primary" onClick={props.onSave} type="button">
            Speichern
          </button>
          <button className="btn btn-outline-primary" onClick={props.onRunAllNotesRoutine} type="button">
            Routine für alle Notizen
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
      <div className="recording-panel modal-panel">
        <div className="d-flex align-items-center justify-content-between gap-3 mb-3">
          <div>
            <p className="small text-uppercase text-secondary fw-semibold mb-1">Aufnahme läuft</p>
            <h3 className="h5 mb-0">Live-Equalizer</h3>
          </div>
          <button className="btn btn-outline-danger btn-sm" onClick={props.onStop} type="button">
            <i className="bi bi-stop-fill me-1" aria-hidden="true" />
            Stop
          </button>
        </div>
        <div className="recording-equalizer" aria-hidden="true">
          {Array.from({ length: 24 }).map((_, index) => {
            const level = props.levels[index] ?? props.levels[props.levels.length - 1] ?? 0.08
            return <span key={index} style={{ height: `${Math.max(16, Math.round(level * 100))}%` }} />
          })}
        </div>
        <p className="small text-secondary mb-0 mt-3">Sprich einfach weiter. Die Aufnahme endet erst, wenn du auf Stop tippst.</p>
      </div>
    </div>
  )
}
