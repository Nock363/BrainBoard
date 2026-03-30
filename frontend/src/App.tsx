import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { api, mediaUrl } from './api'
import { useLongPress } from './hooks/useLongPress'
import { useVoiceRecorder } from './hooks/useVoiceRecorder'
import type { FollowUpQuestionReview, NoteNode, NoteTimelineEntry, SettingsResponse, TabKey } from './types'

function formatRelativeDate(value: string): string {
  if (!value) {
    return ''
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function noteIsProcessing(note: NoteNode): boolean {
  return note.entries.some((entry) => entry.transcriptionState === 'processing')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function uniqueTags(tags: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const tag of tags) {
    const clean = tag.trim()
    if (!clean || seen.has(clean.toLowerCase())) {
      continue
    }
    seen.add(clean.toLowerCase())
    result.push(clean)
  }

  return result.slice(0, 6)
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
  return note.audioRelativePath || note.entries.find((entry) => entry.audioRelativePath)?.audioRelativePath || ''
}

type BusyState = { message: string } | null

type AppHistoryState = {
  tab: TabKey
  selectedNoteId: string
}

type QuestionDecision = {
  noteId: string
  index: number
  text: string
} | null

type SettingsDraft = {
  openAiApiKey: string
  openAiModel: string
  transcriptionModel: string
  summaryModel: string
  followUpModel: string
  language: string
}

const tabs: Array<{ key: TabKey; label: string; icon: string }> = [
  { key: 'capture', label: 'Voice', icon: 'bi-mic-fill' },
  { key: 'live', label: 'Live', icon: 'bi-chat-dots-fill' },
  { key: 'notes', label: 'Notizen', icon: 'bi-journal-text' },
  { key: 'settings', label: 'Setup', icon: 'bi-gear-fill' },
]

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('capture')
  const [notes, setNotes] = useState<NoteNode[]>([])
  const [settings, setSettings] = useState<SettingsResponse | null>(null)
  const [selectedNoteId, setSelectedNoteId] = useState('')
  const [noteDraft, setNoteDraft] = useState('')
  const [textNoteOpen, setTextNoteOpen] = useState(false)
  const [appendDraft, setAppendDraft] = useState('')
  const [busy, setBusy] = useState<BusyState>(null)
  const [error, setError] = useState('')
  const [playingId, setPlayingId] = useState('')
  const [deleteNoteTarget, setDeleteNoteTarget] = useState<NoteNode | null>(null)
  const [deleteAllOpen, setDeleteAllOpen] = useState(false)
  const [questionDecision, setQuestionDecision] = useState<QuestionDecision>(null)
  const [liveSessionActive, setLiveSessionActive] = useState(false)
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
    return (candidate.tab === 'capture' || candidate.tab === 'live' || candidate.tab === 'notes' || candidate.tab === 'settings') && typeof candidate.selectedNoteId === 'string'
  }

  const pushAppState = (tab: TabKey, selectedNoteId: string) => {
    const nextState: AppHistoryState = { tab, selectedNoteId }
    const currentState = isAppHistoryState(window.history.state) ? window.history.state : null
    if (currentState && currentState.tab === nextState.tab && currentState.selectedNoteId === nextState.selectedNoteId) {
      return
    }

    window.history.pushState(nextState, '', window.location.href)
  }

  const goBackWithinApp = () => {
    if (isAppHistoryState(window.history.state) && window.history.state.selectedNoteId) {
      window.history.back()
      return
    }

    setSelectedNoteId('')
  }

  const selectedNote = useMemo(
    () => notes.find((note) => note.id === selectedNoteId) ?? null,
    [notes, selectedNoteId],
  )

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
      setSelectedNoteId(currentState.selectedNoteId)
      window.requestAnimationFrame(() => {
        scrollToTab(currentState.tab, 'auto')
      })
    } else {
      window.history.replaceState({ tab: activeTab, selectedNoteId: selectedNoteId } satisfies AppHistoryState, '', window.location.href)
    }

    const handlePopState = (event: PopStateEvent) => {
      const nextState = isAppHistoryState(event.state) ? event.state : { tab: 'capture' as TabKey, selectedNoteId: '' }
      setActiveTab(nextState.tab)
      setSelectedNoteId(nextState.selectedNoteId)
      window.requestAnimationFrame(() => {
        scrollToTab(nextState.tab, 'auto')
      })
    }

    window.addEventListener('popstate', handlePopState)
    return () => {
      window.removeEventListener('popstate', handlePopState)
    }
  }, [])

  useEffect(() => {
    if (textNoteOpen && activeTab !== 'capture') {
      setTextNoteOpen(false)
    }
  }, [activeTab, textNoteOpen])

  useEffect(() => {
    return () => {
      if (pageScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(pageScrollFrameRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!recorder.error) {
      return
    }
    setError(recorder.error)
  }, [recorder.error])

  useEffect(() => {
    if (!selectedNote) {
      setAppendDraft('')
    }
  }, [selectedNote?.id])

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
    pushAppState('notes', noteId)
    setActiveTab('notes')
    setSelectedNoteId(noteId)
    scrollToTab('notes')
  }

  const waitForProcessedNote = async (noteId: string) => {
    let noteResponse = await api.getNote(noteId)
    for (let attempt = 0; attempt < 20 && noteIsProcessing(noteResponse.note); attempt += 1) {
      await sleep(800)
      noteResponse = await api.getNote(noteId)
    }
    return noteResponse.note
  }

  const finishVoiceCapture = async (response: { note: NoteNode }) => {
    const readyNote = noteIsProcessing(response.note) ? await waitForProcessedNote(response.note.id) : response.note
    const current = await updateNotesFromResponse({ note: readyNote })
    openNoteDetail(current.id)
  }

  const startLiveSession = () => {
    if (busy || recorder.isRecording || liveSessionActive) {
      return
    }
    setTextNoteOpen(false)
    pushAppState('live', selectedNoteId)
    setActiveTab('live')
    setLiveSessionActive(true)
  }

  const stopLiveSession = () => {
    setLiveSessionActive(false)
  }

  const startVoiceCapture = async (noteId?: string) => {
    if (recorder.isRecording || liveSessionActive || busy) {
      return
    }
    setTextNoteOpen(false)
    pushAppState('capture', selectedNoteId)
    setActiveTab('capture')
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
      return target
        ? api.createVoiceNote(recorded.blob, recorded.mimeType, target)
        : api.createVoiceNote(recorded.blob, recorded.mimeType)
    })
    await finishVoiceCapture(response)
  }

  const submitTextNote = async () => {
    if (busy || recorder.isRecording || liveSessionActive) {
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

  const appendTextToNote = async () => {
    if (!selectedNote) {
      return
    }
    const clean = appendDraft.trim()
    if (!clean) {
      setError('Bitte erst Text für die Notiz eingeben.')
      return
    }
    setAppendDraft('')
    const response = await runBusy('Text wird zur Notiz hinzugefügt …', async () => api.appendText(selectedNote.id, clean))
    await updateNotesFromResponse(response)
    setSelectedNoteId(response.note.id)
  }

  const regenerateSummary = async () => {
    if (!selectedNote) {
      return
    }
    const response = await runBusy('Zusammenfassung wird neu erstellt …', async () => api.regenerateSummary(selectedNote.id))
    await updateNotesFromResponse(response)
  }

  const toggleTodo = async (index: number, nextChecked: boolean) => {
    if (!selectedNote) {
      return
    }
    const response = await api.toggleTodo(selectedNote.id, index, nextChecked)
    await updateNotesFromResponse(response)
  }

  const dismissQuestion = async (index: number, reason: 'schon beantwortet' | 'unwichtig') => {
    if (!selectedNote) {
      return
    }
    const response = await runBusy('Folgefrage wird aussortiert …', async () => api.dismissQuestion(selectedNote.id, index, reason))
    await updateNotesFromResponse(response)
  }

  const retryTranscription = async (entry: NoteTimelineEntry) => {
    if (!selectedNote) {
      return
    }
    const response = await runBusy('Transkription wird erneut versucht …', async () => api.retryTranscription(selectedNote.id, entry.id))
    await updateNotesFromResponse(response)
  }

  const deleteSelectedNote = async () => {
    if (!deleteNoteTarget) {
      return
    }
    await runBusy('Notiz wird gelöscht …', async () => api.deleteNote(deleteNoteTarget.id))
    setDeleteNoteTarget(null)
    goBackWithinApp()
    await reloadNotes()
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

  const noteCount = notes.length
  const captureStartEnabled = !busy && !recorder.isRecording && !liveSessionActive
  const liveStartEnabled = !busy && !recorder.isRecording && !liveSessionActive

  const scrollToTab = (tab: TabKey, behavior: ScrollBehavior = 'smooth') => {
    const slider = pageSliderRef.current
    if (!slider) {
      return
    }

    const index = tabs.findIndex((item) => item.key === tab)
    if (index < 0) {
      return
    }

    slider.scrollTo({
      left: slider.clientWidth * index,
      behavior,
    })
  }

  const activateTab = (tab: TabKey) => {
    pushAppState(tab, selectedNoteId)
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

  return (
    <div className={`bootstrap-app text-body ${activeTab === 'live' ? 'live-mode' : ''}`}>
      <div className="container-fluid app-shell py-2 py-lg-3 d-flex flex-column gap-2">
        <main className="flex-grow-1 overflow-hidden pb-0 pt-0">
          <div className="page-slider h-100" ref={pageSliderRef} onScroll={handlePageScroll}>
            <section className="page-panel d-flex flex-column gap-3 h-100">
              <CaptureView
                startVoiceCapture={() => void startVoiceCapture()}
                isRecording={recorder.isRecording}
                startEnabled={captureStartEnabled}
                microphoneHint={recorder.microphoneHint}
                onOpenTextNote={() => setTextNoteOpen(true)}
              />
            </section>

            <section className="page-panel live-page-panel d-flex flex-column gap-3 h-100">
              <LiveView
                liveSessionActive={liveSessionActive}
                startEnabled={liveStartEnabled}
                onStartLiveSession={startLiveSession}
                onStopLiveSession={stopLiveSession}
              />
            </section>

            <section className="page-panel notes-page-panel d-flex flex-column gap-3 h-100">
              <NotesView
                notes={notes}
                selectedNote={selectedNote}
                setSelectedNoteId={setSelectedNoteId}
                onOpenCaptureForNote={(noteId) => void startVoiceCapture(noteId)}
                onTogglePlayback={(id, url) => void playAudio(id, url)}
                currentlyPlayingId={playingId}
                appendDraft={appendDraft}
                setAppendDraft={setAppendDraft}
                appendTextToNote={() => void appendTextToNote()}
                regenerateSummary={() => void regenerateSummary()}
                toggleTodo={(index, checked) => void toggleTodo(index, checked)}
                dismissQuestion={(index, reason) => void dismissQuestion(index, reason)}
                retryTranscription={(entry) => void retryTranscription(entry)}
                deleteNote={(note) => setDeleteNoteTarget(note)}
                backToList={goBackWithinApp}
                onOpenQuestionDecision={(index, text) => setQuestionDecision({ noteId: selectedNote?.id ?? '', index, text })}
              />
            </section>

            <section className="page-panel d-flex flex-column gap-3 h-100">
              <SettingsView
                settings={settings}
                settingsDraft={settingsDraft}
                setSettingsDraft={setSettingsDraft}
                saveSettings={() => void saveSettings()}
                exportTechnicalReport={() => void exportTechnicalReport()}
                reportStatus={reportStatus}
                reportDownload={reportDownload}
                deleteAllNotes={() => setDeleteAllOpen(true)}
              />
            </section>
          </div>
        </main>

        <nav className="navbar navbar-expand fixed-bottom border-top bg-light shadow-sm app-bottom-nav" aria-label="Seitennavigation">
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

        {recorder.isRecording && <RecordingOverlay levels={recorder.levels} onStop={() => void stopVoiceCapture()} />}
        {busy && <LoadingOverlay message={busy.message} />}
        {error && <ErrorOverlay message={error} onDismiss={() => setError('')} />}

        {questionDecision && (
          <QuestionDecisionModal
            question={questionDecision}
            onClose={() => setQuestionDecision(null)}
            onDismiss={(reason) => {
              const current = questionDecision
              setQuestionDecision(null)
              if (current) {
                void dismissQuestion(current.index, reason)
              }
            }}
          />
        )}

        {deleteNoteTarget && (
          <ConfirmationModal
            title="Notiz löschen?"
            message={`Die Notiz „${deleteNoteTarget.title || 'Untitled Note'}“ wird dauerhaft entfernt.`}
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

function CaptureView(props: {
  startVoiceCapture: () => void
  isRecording: boolean
  startEnabled: boolean
  microphoneHint: string
  onOpenTextNote: () => void
}) {
  return (
    <section className="h-100 d-flex flex-column gap-4 capture-screen-shell">
      <div className="capture-hero text-center mx-auto d-flex flex-column justify-content-center">
        <span className="badge rounded-pill capture-badge mx-auto mb-3">Voice first</span>
        <p className="small text-uppercase text-secondary fw-semibold mb-2">BrainSession</p>
        <h2 className="capture-title mb-2">Sprich los. BrainSession ordnet den Rest.</h2>
        <p className="capture-subtitle text-secondary mb-0">Dein Startpunkt für schnelle Sprachideen und klare Notizen.</p>
      </div>

      <div className="flex-grow-1 d-flex align-items-end">
        <div className="card border-0 shadow-sm w-100 voice-stage-card">
          <div className="card-body p-3 p-lg-4 d-flex flex-column align-items-center text-center gap-3 voice-stage-card-body">
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
              <h3 className="h5 mb-1">Sprachnotiz aufnehmen</h3>
              <p className="text-secondary mb-0">Der zentrale Button bleibt in Daumennähe und dominiert den Screen.</p>
            </div>
            {props.microphoneHint ? <div className="alert alert-warning mb-0 py-2 w-100">{props.microphoneHint}</div> : null}
            <button className="btn btn-outline-secondary w-100" onClick={props.onOpenTextNote} type="button">
              <i className="bi bi-pencil-square me-1" aria-hidden="true" />
              Textnotiz erstellen
            </button>
          </div>
        </div>
      </div>

    </section>
  )
}

function LiveView(props: {
  liveSessionActive: boolean
  startEnabled: boolean
  onStartLiveSession: () => void
  onStopLiveSession: () => void
}) {
  const transcript = props.liveSessionActive
    ? [
        {
          role: 'assistant' as const,
          title: 'BrainSession',
          text: 'Live-Session aktiv. Der komplette Bildschirm gehört jetzt dem Gesprächsverlauf.',
        },
        {
          role: 'user' as const,
          title: 'Du',
          text: 'Bitte halte die Konversation kompakt und fokussiere dich auf die nächste Aktion.',
        },
        {
          role: 'assistant' as const,
          title: 'BrainSession',
          text: 'Hier würden fortlaufend die Antworten und Transkript-Segmente auftauchen.',
        },
      ]
    : []
  const currentSpeaker = transcript.length > 0 ? transcript[transcript.length - 1].role : 'assistant'

  return (
    <section className="h-100 d-flex flex-column live-view-shell">
      <div className="card border-0 shadow-sm flex-grow-1 live-history-shell">
        <div className="card-body p-3 p-lg-4 d-flex flex-column gap-3 h-100 live-history-shell-inner">
          {props.liveSessionActive ? (
            <div className="d-flex align-items-center justify-content-between gap-3 flex-wrap">
              <span className="badge rounded-pill text-bg-success">
                <i className="bi bi-broadcast-pin me-1" aria-hidden="true" />
                LIVE
              </span>
              <span className="small text-secondary fw-semibold">
                {currentSpeaker === 'user' ? 'Du sprichst' : 'Agent spricht'}
              </span>
            </div>
          ) : (
            <div className="live-empty-copy text-center pt-1">
              <i className="bi bi-chat-square-dots-fill text-primary live-empty-icon mb-2" aria-hidden="true" />
              <h3 className="h5 mb-1">Live-Session bereit</h3>
              <p className="text-secondary mb-0">Tippe auf Start. Danach bleibt nur der Chat scrollbar.</p>
            </div>
          )}

          <div className="live-history flex-grow-1 d-flex flex-column gap-3">
            {props.liveSessionActive ? (
              transcript.map((entry, index) => (
                <div
                  key={`${entry.role}-${index}`}
                  className={`live-message rounded-4 p-3 ${entry.role === 'user' ? 'live-message-user align-self-end' : 'live-message-assistant align-self-start'}`}
                >
                  <div className="small text-uppercase fw-semibold text-secondary mb-1">{entry.title}</div>
                  <div className="fw-medium">{entry.text}</div>
                </div>
              ))
            ) : null}
          </div>

          <div className="live-control-card card border-0 shadow-sm">
            <div className="card-body p-3 p-lg-4 d-flex flex-column gap-2">
              <LiveSpeakerIndicator activeSpeaker={props.liveSessionActive ? currentSpeaker : 'idle'} />
              <button
                className={`btn btn-lg w-100 ${props.liveSessionActive ? 'btn-outline-danger' : 'btn-primary'}`}
                onClick={props.liveSessionActive ? props.onStopLiveSession : props.onStartLiveSession}
                type="button"
                disabled={!props.liveSessionActive && !props.startEnabled}
              >
                <i className={`bi ${props.liveSessionActive ? 'bi-stop-fill' : 'bi-play-fill'} me-2`} aria-hidden="true" />
                {props.liveSessionActive ? 'Stop' : 'Start'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function LiveSpeakerIndicator(props: { activeSpeaker: 'user' | 'assistant' | 'idle' }) {
  const isIdle = props.activeSpeaker === 'idle'
  const userActive = props.activeSpeaker === 'user'
  const agentActive = props.activeSpeaker === 'assistant'

  return (
    <div className="live-speaker-strip rounded-3 border bg-body-tertiary" aria-hidden="true">
      <span className={`badge rounded-pill ${userActive ? 'text-bg-primary' : 'text-bg-light border text-secondary'}`}>
        <i className="bi bi-person-fill me-1" aria-hidden="true" />
        Du
      </span>

      <div className="live-speaker-status d-flex align-items-center gap-2 text-secondary">
        <span className={`live-speaker-dot ${userActive ? 'user' : agentActive ? 'agent' : 'idle'}`} />
        <span className="small fw-semibold">
          {isIdle ? 'Bereit' : userActive ? 'Du sprichst' : 'Agent spricht'}
        </span>
      </div>

      <span className={`badge rounded-pill ${agentActive ? 'text-bg-success' : 'text-bg-light border text-secondary'}`}>
        <i className="bi bi-robot me-1" aria-hidden="true" />
        Agent
      </span>
    </div>
  )
}

function NotesView(props: {
  notes: NoteNode[]
  selectedNote: NoteNode | null
  setSelectedNoteId: (value: string) => void
  onOpenCaptureForNote: (noteId: string) => void
  onTogglePlayback: (id: string, url: string) => void
  currentlyPlayingId: string
  appendDraft: string
  setAppendDraft: (value: string) => void
  appendTextToNote: () => void
  regenerateSummary: () => void
  toggleTodo: (index: number, checked: boolean) => void
  dismissQuestion: (index: number, reason: 'schon beantwortet' | 'unwichtig') => void
  retryTranscription: (entry: NoteTimelineEntry) => void
  deleteNote: (note: NoteNode) => void
  backToList: () => void
  onOpenQuestionDecision: (index: number, text: string) => void
}) {
  if (!props.selectedNote) {
    return (
      <section className="vstack gap-3 notes-overview-stack">
        <div className="card border-0 shadow-sm">
          <div className="card-body p-3 p-lg-4 d-flex flex-column gap-3">
            <div className="d-flex align-items-start justify-content-between gap-3">
              <div>
                <p className="small text-uppercase text-secondary fw-semibold mb-1">Notizen</p>
                <h2 className="h4 mb-0">Deine Sammlung</h2>
              </div>
              <div className="d-flex flex-wrap gap-2 justify-content-end">
                <span className="badge rounded-pill text-bg-light border text-secondary">Gesamt {props.notes.length}</span>
                <span className="badge rounded-pill text-bg-light border text-secondary">
                  <i className="bi bi-headphones me-1" aria-hidden="true" />
                  Audio {props.notes.filter((note) => Boolean(noteAudioPath(note))).length}
                </span>
              </div>
            </div>
          </div>
        </div>

        {props.notes.length === 0 ? (
          <div className="alert alert-light border shadow-sm mb-0">
            Noch keine Notizen vorhanden. Starte eine Sprachnotiz oder lege Text direkt an.
          </div>
        ) : (
          <div className="vstack gap-3">
            {props.notes.map((note) => (
              <NoteCard
                key={note.id}
                note={note}
                playing={props.currentlyPlayingId === note.id}
                selected={false}
                isNewest={props.notes[0]?.id === note.id}
                onOpen={() => props.setSelectedNoteId(note.id)}
                onSelect={() => props.setSelectedNoteId(note.id)}
                onTogglePlayback={() => {
                  const audioPath = noteAudioPath(note)
                  if (audioPath) {
                    props.onTogglePlayback(note.id, mediaUrl(audioPath))
                  }
                }}
                onDelete={() => props.deleteNote(note)}
              />
            ))}
          </div>
        )}
      </section>
    )
  }

  const note = props.selectedNote
  const audioPath = noteAudioPath(note)
  const hasAudio = Boolean(audioPath)

  return (
    <section className="notes-detail-stack vstack gap-3">
      <div className="card border-0 shadow-sm detail-sticky">
        <div className="card-body p-3 p-lg-4 d-flex flex-column gap-3">
          <div className="d-flex flex-wrap align-items-start justify-content-between gap-3">
            <div>
              <div className="d-flex flex-wrap gap-2 mb-3">
                <span className="badge text-bg-primary-subtle text-primary border border-primary-subtle">Detail</span>
                <span className="badge text-bg-light border">{formatRelativeDate(note.updatedAt)}</span>
                {hasAudio && (
                  <span className="badge text-bg-light border">
                    <i className="bi bi-headphones me-1" aria-hidden="true" />
                    Audio
                  </span>
                )}
              </div>
              <h2 className="h3 mb-1">{note.title || 'Untitled Note'}</h2>
              <p className="text-secondary small mb-0">{note.entries.length} Einträge · {uniqueTags(note.tags).length} Tags · zuletzt bearbeitet {formatRelativeDate(note.updatedAt)}</p>
            </div>
            <div className="d-flex flex-wrap gap-2 align-self-start">
              <button className="btn btn-outline-secondary" onClick={props.backToList} type="button">
                <i className="bi bi-arrow-left me-1" aria-hidden="true" />
                Zurück
              </button>
              <button className="btn btn-outline-primary" onClick={() => props.onOpenCaptureForNote(note.id)} type="button">
                <i className="bi bi-mic-fill me-1" aria-hidden="true" />
                Sprachnotiz ergänzen
              </button>
              <button className="btn btn-outline-danger" onClick={() => props.deleteNote(note)} type="button">
                <i className="bi bi-trash3-fill me-1" aria-hidden="true" />
                Löschen
              </button>
            </div>
          </div>

          <div className="d-flex flex-wrap gap-2">
            {uniqueTags(note.tags).map((tag) => (
              <span className="badge rounded-pill text-bg-light border text-secondary" key={tag}>
                {tag}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="card border-0 shadow-sm notes-summary-card">
        <div className="card-body p-3 p-lg-4">
          <div className="d-flex align-items-center justify-content-between gap-3 mb-3">
            <p className="small text-uppercase text-secondary fw-semibold mb-0">Zusammenfassung</p>
            {hasAudio && (
              <button className="btn btn-outline-primary btn-sm" onClick={() => props.onTogglePlayback(note.id, mediaUrl(audioPath))} type="button">
                <i className="bi bi-play-circle me-1" aria-hidden="true" />
                Audio {props.currentlyPlayingId === note.id ? 'stoppen' : 'abspielen'}
              </button>
            )}
          </div>

          <p className="note-summary note-summary-full mb-0">{note.summary || 'Noch keine Zusammenfassung vorhanden.'}</p>

          {note.rawTranscript && (
            <details className="mt-4">
              <summary className="small text-uppercase text-secondary fw-semibold">Originalverlauf</summary>
              <div className="bg-light border rounded-4 p-3 mt-3">
                <p className="mb-0">{note.rawTranscript}</p>
              </div>
            </details>
          )}

          {note.bullets.length > 0 && (
            <div className="mt-4">
              <p className="small text-uppercase text-secondary fw-semibold mb-2">Kernaussagen</p>
              <ul className="list-group list-group-flush rounded-4 overflow-hidden shadow-sm">
                {note.bullets.map((bullet) => (
                  <li className="list-group-item bg-light border-start-0 border-end-0" key={bullet}>
                    {bullet}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <div className="card border-0 shadow-sm">
        <div className="card-body p-3 p-lg-4">
          <SummarySectionsCard
            note={note}
            onToggleTodo={props.toggleTodo}
            onDismissQuestion={props.dismissQuestion}
            onOpenQuestionDecision={props.onOpenQuestionDecision}
          />
        </div>
      </div>

      <div className="card border-0 shadow-sm">
        <div className="card-body p-3 p-lg-4">
          <p className="small text-uppercase text-secondary fw-semibold mb-1">Timeline</p>
          <h3 className="h5 mb-3">Einträge & Audio</h3>
          <div className="d-flex flex-column gap-3">
            {note.entries.map((entry, index) => (
              <TimelineEntryCard
                key={entry.id}
                entry={entry}
                index={index}
                playing={props.currentlyPlayingId === entry.id}
                onPlay={() => {
                  if (entry.audioRelativePath) {
                    props.onTogglePlayback(entry.id, mediaUrl(entry.audioRelativePath))
                  }
                }}
                onRetry={() => props.retryTranscription(entry)}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="card border-0 shadow-sm">
        <div className="card-body p-3 p-lg-4">
          <p className="small text-uppercase text-secondary fw-semibold mb-1">Ergänzen</p>
          <h3 className="h5">Text zur Notiz anhängen</h3>
          <textarea
            className="form-control form-control-lg mb-3"
            rows={6}
            value={props.appendDraft}
            onChange={(event) => props.setAppendDraft(event.target.value)}
            placeholder="Zusätzlichen Kontext hinzufügen …"
          />
          <div className="d-flex flex-wrap gap-2">
            <button className="btn btn-primary flex-grow-1" onClick={props.appendTextToNote} type="button" disabled={!props.appendDraft.trim()}>
              <i className="bi bi-plus-lg me-1" aria-hidden="true" />
              Anhängen
            </button>
            <button className="btn btn-outline-secondary flex-grow-1" onClick={props.regenerateSummary} type="button">
              <i className="bi bi-arrow-repeat me-1" aria-hidden="true" />
              Zusammenfassung neu
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

function NoteCard(props: {
  note: NoteNode
  onOpen: () => void
  onSelect: () => void
  onTogglePlayback: () => void
  onDelete: () => void
  playing: boolean
  selected: boolean
  isNewest: boolean
}) {
  const tags = uniqueTags(props.note.tags)
  const hasPending = props.note.entries.some((entry) => entry.transcriptionState === 'pending_retry')
  const hasAudio = Boolean(noteAudioPath(props.note))

  return (
    <article
      className={`card border-0 shadow-sm note-card ${props.selected ? 'selected' : ''} ${props.isNewest ? 'note-card-newest' : ''}`}
      role="button"
      tabIndex={0}
      onClick={props.onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          props.onSelect()
        }
      }}
    >
      <div className="card-body note-card-body">
        <div className="d-flex justify-content-between gap-3 mb-2">
          <div>
            <div className="small text-muted mb-1">{formatRelativeDate(props.note.updatedAt)}</div>
            <div className="d-flex flex-wrap align-items-center gap-2 mb-1">
              <h3 className="h5 mb-0">{props.note.title || 'Untitled Note'}</h3>
              {props.isNewest && <span className="badge rounded-pill text-bg-primary">Neu</span>}
            </div>
            <div className="note-card-summary text-body">{props.note.summary || 'Noch keine Zusammenfassung vorhanden.'}</div>
          </div>
          <div className="d-flex flex-column gap-2 align-items-end">
            {hasAudio && (
              <span className={`badge rounded-pill ${props.playing ? 'text-bg-primary' : 'text-bg-light border text-secondary'}`}>
                <i className={`bi ${props.playing ? 'bi-soundwave' : 'bi-headphones'} me-1`} aria-hidden="true" />
                {props.playing ? 'Läuft' : 'Audio'}
              </span>
            )}
            {hasPending && <span className="badge rounded-pill text-bg-warning text-dark">Offen</span>}
          </div>
        </div>
        <div className="d-flex flex-wrap gap-2 mb-3 note-tag-group">
          {tags.map((tag) => (
            <span className="badge rounded-pill text-bg-light border text-secondary note-tag" key={tag}>
              {tag}
            </span>
          ))}
        </div>
        <div className="small text-muted mt-3">{props.note.entries.length} Einträge</div>
      </div>
    </article>
  )
}

function TimelineEntryCard(props: {
  entry: NoteTimelineEntry
  index: number
  playing: boolean
  onPlay: () => void
  onRetry: () => void
}) {
  const voice = props.entry.kind === 'voice' || Boolean(props.entry.audioRelativePath)

  return (
    <div className="card border-0 shadow-sm timeline-card">
      <div className="card-body p-3 p-lg-4">
        <div className="d-flex justify-content-between align-items-start gap-3 mb-2">
          <div>
            <p className="small text-muted text-uppercase fw-semibold mb-1">
              Eintrag {props.index + 1}
            </p>
            <div className="fw-semibold">{formatRelativeDate(props.entry.createdAt)}</div>
          </div>
          <span className={`badge rounded-pill ${voice ? 'text-bg-primary' : 'text-bg-light border text-secondary'}`}>
            <i className={`bi ${voice ? 'bi-mic-fill' : 'bi-pencil-square'} me-1`} aria-hidden="true" />
            {voice ? 'Sprach' : 'Text'}
          </span>
        </div>
        <p className="mb-3 text-body">{props.entry.transcript || '(leer)'}</p>
        {props.entry.transcriptionState === 'pending_retry' && (
          <div className="alert alert-warning py-2 mb-3">
            <p className="mb-2">
              {props.entry.transcriptionError || 'Die Transkription ist fehlgeschlagen. Die Aufnahme kann erneut verarbeitet werden.'}
            </p>
            <button className="btn btn-outline-warning btn-sm" onClick={props.onRetry} type="button">
              Neu transkribieren
            </button>
          </div>
        )}
        {voice && props.entry.audioRelativePath && (
          <button className="btn btn-outline-primary btn-sm" onClick={props.onPlay} type="button">
            <i className={`bi ${props.playing ? 'bi-pause-fill' : 'bi-play-fill'} me-1`} aria-hidden="true" />
            {props.playing ? 'Audio stoppen' : 'Audio abspielen'}
          </button>
        )}
      </div>
    </div>
  )
}

function SummarySectionsCard(props: {
  note: NoteNode
  onToggleTodo: (index: number, checked: boolean) => void
  onDismissQuestion: (index: number, reason: 'schon beantwortet' | 'unwichtig') => void
  onOpenQuestionDecision: (index: number, text: string) => void
}) {
  const note = props.note
  const summarySections = note.summarySections
  const hasReviewed = note.followUpQuestionReviews.length > 0
  const hasTodos = summarySections.todos.length > 0
  const hasMilestones = summarySections.milestones.length > 0
  const hasQuestions = summarySections.questions.length > 0

  return (
    <div className="vstack gap-4">
      <div>
        <p className="small text-uppercase text-secondary fw-semibold mb-2">Weitere Inhalte</p>
        <p className="text-secondary mb-0">To-dos, Folgefragen und aussortierte Gedanken bleiben hier direkt im Blick, ohne die Zusammenfassung zu verstecken.</p>
      </div>

      {hasTodos && (
        <div>
          <p className="small text-uppercase text-secondary fw-semibold mb-2">To-dos</p>
          <div className="vstack gap-2">
            {summarySections.todos.map((todo, index) => {
              const checked = summarySections.todoStates[index] === true
              return (
                <label className="form-check d-flex align-items-center gap-2 p-3 bg-white border rounded-4 mb-0" key={`${todo}-${index}`}>
                  <input className="form-check-input mt-0" type="checkbox" checked={checked} onChange={(event) => props.onToggleTodo(index, event.target.checked)} />
                  <span className={checked ? 'text-decoration-line-through text-secondary' : ''}>{todo}</span>
                </label>
              )
            })}
          </div>
        </div>
      )}

      {hasMilestones && (
        <div>
          <p className="small text-uppercase text-secondary fw-semibold mb-2">Milestones / Ziele</p>
          <ul className="list-group list-group-flush rounded-4 overflow-hidden">
            {summarySections.milestones.map((milestone) => (
              <li className="list-group-item bg-white" key={milestone}>
                {milestone}
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasQuestions && (
        <div>
          <p className="small text-uppercase text-secondary fw-semibold mb-2">Folgefragen</p>
          <div className="vstack gap-2">
            {summarySections.questions.map((question, index) => (
              <QuestionCard key={`${question}-${index}`} question={question} index={index} onOpenDecision={props.onOpenQuestionDecision} />
            ))}
          </div>
        </div>
      )}

      {hasReviewed && (
        <div>
          <p className="small text-uppercase text-secondary fw-semibold mb-2">Aussortiert</p>
          <div className="vstack gap-2">
            {note.followUpQuestionReviews.map((review) => (
              <ReviewedQuestionCard key={`${review.question}-${review.createdAt}`} review={review} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function QuestionCard(props: {
  question: string
  index: number
  onOpenDecision: (index: number, text: string) => void
}) {
  const longPress = useLongPress(() => props.onOpenDecision(props.index, props.question))

  return (
    <button
      className="question-card btn btn-outline-secondary text-start p-3 rounded-4"
      type="button"
      onClick={() => props.onOpenDecision(props.index, props.question)}
      {...longPress}
    >
      <div className="d-flex justify-content-between align-items-start gap-3">
        <div>
          <div className="small text-secondary text-uppercase mb-1">Folgefrage {props.index + 1}</div>
          <div className="fw-semibold">{props.question}</div>
        </div>
        <span className="badge text-bg-light border align-self-start">Hold</span>
      </div>
    </button>
  )
}

function ReviewedQuestionCard(props: { review: FollowUpQuestionReview }) {
  return (
    <div className="border rounded-4 p-3 bg-white shadow-sm">
      <div className="d-flex justify-content-between align-items-start gap-3 mb-2">
        <div>
          <div className="small text-secondary text-uppercase fw-semibold mb-1">Aussortiert</div>
          <div className="fw-semibold">{props.review.question}</div>
        </div>
        <span className="badge text-bg-secondary">{props.review.reason}</span>
      </div>
      <div className="small text-secondary">{formatRelativeDate(props.review.createdAt)}</div>
    </div>
  )
}

function SettingsView(props: {
  settings: SettingsResponse | null
  settingsDraft: SettingsDraft
  setSettingsDraft: Dispatch<SetStateAction<SettingsDraft>>
  saveSettings: () => void
  exportTechnicalReport: () => void
  reportStatus: string
  reportDownload: string
  deleteAllNotes: () => void
}) {
  if (!props.settings) {
    return <div className="alert alert-light border shadow-sm">Einstellungen werden geladen …</div>
  }

  return (
    <section className="row g-3">
      <div className="col-12 col-xl-7">
        <div className="card border-0 shadow-sm">
          <div className="card-body p-3 p-lg-4">
            <div className="d-flex flex-wrap align-items-start justify-content-between gap-3 mb-3">
              <div>
                <p className="small text-uppercase text-secondary fw-semibold mb-1">Setup</p>
                <h2 className="h4 mb-0">Technik bleibt im Hintergrund</h2>
              </div>
              <span className={`badge rounded-pill ${props.settings.openAiApiKeyPresent ? 'text-bg-light border text-success' : 'text-bg-light border text-secondary'}`}>
                <span className={`status-dot ${props.settings.openAiApiKeyPresent ? 'bg-success' : 'bg-secondary'}`} />
                {props.settings.openAiApiKeyPresent ? 'API-Key aktiv' : 'Kein API-Key'}
              </span>
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

              <div className="col-12">
                <div className="input-group">
                  <span className="input-group-text">Follow-up Model</span>
                  <input
                    id="settings-follow-up-model"
                    className="form-control"
                    value={props.settingsDraft.followUpModel}
                    onChange={(event) => props.setSettingsDraft((current) => ({ ...current, followUpModel: event.target.value }))}
                  />
                </div>
              </div>
            </div>

            <div className="d-flex flex-wrap gap-2 mt-4">
              <button className="btn btn-primary" onClick={props.saveSettings} type="button">
                <i className="bi bi-check2-circle me-1" aria-hidden="true" />
                Speichern
              </button>
              <button className="btn btn-outline-secondary" onClick={props.exportTechnicalReport} type="button">
                <i className="bi bi-file-earmark-text me-1" aria-hidden="true" />
                Technischen Report exportieren
              </button>
              <button className="btn btn-outline-danger" onClick={props.deleteAllNotes} type="button">
                <i className="bi bi-trash3-fill me-1" aria-hidden="true" />
                Alle Notizen löschen
              </button>
            </div>

            {props.reportStatus && <div className="alert alert-success mt-3 mb-0">{props.reportStatus}</div>}
          </div>
        </div>
      </div>

      <div className="col-12 col-xl-5 d-flex flex-column gap-3">
        <div className="card border-0 shadow-sm">
          <div className="card-body p-3 p-lg-4">
            <p className="small text-uppercase text-secondary fw-semibold mb-1">Optimierungsnotizen</p>
            {props.reportDownload && (
              <p className="text-secondary small mb-3">
                Zuletzt exportiert: <span className="text-body">{props.reportDownload}</span>
              </p>
            )}
            <p className="text-secondary mb-0">Die Kotlin-App sammelt hier nur technische Notizen; die PWA behält denselben inneren Platz dafür.</p>
          </div>
        </div>
      </div>
    </section>
  )
}

function RecordingOverlay(props: { levels: number[]; onStop: () => void }) {
  const visibleLevels = props.levels.length > 0 ? props.levels.slice(-24) : Array.from({ length: 18 }, (_, index) => 0.08 + (index % 4) * 0.04)

  return (
    <div className="position-fixed top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center" style={{ zIndex: 1050, background: 'rgba(15, 23, 42, 0.45)' }}>
      <div className="modal-dialog modal-dialog-centered m-0 w-100 px-3" style={{ maxWidth: '28rem' }}>
        <div className="modal-content modal-panel p-4">
          <div className="d-flex align-items-start justify-content-between gap-3 mb-3">
            <div>
              <p className="small text-uppercase text-secondary fw-semibold mb-1">Aufnahme läuft</p>
              <h3 className="h5 mb-0">Die letzten Sekunden werden live angezeigt.</h3>
            </div>
            <span className="badge rounded-pill text-bg-danger">LIVE</span>
          </div>

          <div className="d-flex align-items-end justify-content-between gap-2 record-meter mb-4" aria-hidden="true">
            {visibleLevels.map((level, index) => (
              <span key={index} style={{ height: `${Math.max(12, 18 + level * 74)}%`, opacity: 0.45 + level * 0.55 }} />
            ))}
          </div>

          <button className="btn btn-danger w-100" onClick={props.onStop} type="button">
            Stop
          </button>
        </div>
      </div>
    </div>
  )
}

function LoadingOverlay(props: { message: string }) {
  return (
    <div className="position-fixed top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center" style={{ zIndex: 1045, background: 'rgba(15, 23, 42, 0.3)' }}>
      <div className="modal-dialog modal-dialog-centered m-0 w-100 px-3" style={{ maxWidth: '24rem' }}>
        <div className="modal-content modal-panel p-4 text-center">
          <div className="d-flex justify-content-center mb-3" aria-hidden="true">
            <div className="spinner-border text-primary" role="status">
              <span className="visually-hidden">Lädt …</span>
            </div>
          </div>
          <h3 className="h5 mb-2">{props.message}</h3>
          <div className="progress mb-3" style={{ height: '0.45rem' }} aria-hidden="true">
            <div className="progress-bar progress-bar-striped progress-bar-animated w-100" />
          </div>
          <p className="text-secondary mb-0">Die Verarbeitung läuft noch im Hintergrund. Danach springt die App automatisch zur Notiz.</p>
        </div>
      </div>
    </div>
  )
}

function ErrorOverlay(props: { message: string; onDismiss: () => void }) {
  return (
    <div className="position-fixed top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center" style={{ zIndex: 1060, background: 'rgba(15, 23, 42, 0.35)' }}>
      <div className="modal-dialog modal-dialog-centered m-0 w-100 px-3" style={{ maxWidth: '28rem' }}>
        <div className="modal-content modal-panel p-4 text-center">
          <div className="display-6 text-danger fw-bold mb-2">!</div>
          <h3 className="h5">Etwas hat nicht geklappt</h3>
          <p className="text-secondary">{props.message}</p>
          <button className="btn btn-primary" onClick={props.onDismiss} type="button">
            Verstanden
          </button>
        </div>
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
    <div className="position-fixed top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center" style={{ zIndex: 1070, background: 'rgba(15, 23, 42, 0.35)' }}>
      <div className="modal-dialog modal-dialog-centered m-0 w-100 px-3" style={{ maxWidth: '30rem' }}>
        <div className="modal-content modal-panel p-4">
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
    </div>
  )
}

function QuestionDecisionModal(props: {
  question: QuestionDecision
  onClose: () => void
  onDismiss: (reason: 'schon beantwortet' | 'unwichtig') => void
}) {
  if (!props.question) {
    return null
  }

  return (
    <div className="position-fixed top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center" style={{ zIndex: 1080, background: 'rgba(15, 23, 42, 0.35)' }}>
      <div className="modal-dialog modal-dialog-centered m-0 w-100 px-3" style={{ maxWidth: '30rem' }}>
        <div className="modal-content modal-panel p-4">
          <p className="small text-uppercase text-secondary fw-semibold mb-1">Folgefrage markieren?</p>
          <h3 className="h5">{props.question.text}</h3>
          <div className="d-flex flex-wrap gap-2 mt-3">
            <button className="btn btn-primary" onClick={() => props.onDismiss('schon beantwortet')} type="button">
              schon beantwortet
            </button>
            <button className="btn btn-outline-secondary" onClick={() => props.onDismiss('unwichtig')} type="button">
              unwichtig
            </button>
          </div>
          <button className="btn btn-link mt-2 px-0 text-decoration-none" onClick={props.onClose} type="button">
            Abbrechen
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
    <div className="position-fixed top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center" style={{ zIndex: 1075, background: 'rgba(15, 23, 42, 0.35)' }}>
      <div className="modal-dialog modal-dialog-centered m-0 w-100 px-3" style={{ maxWidth: '34rem' }}>
        <div className="modal-content modal-panel p-4">
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
    </div>
  )
}
