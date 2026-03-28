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

function preview(value: string, limit = 180): string {
  const clean = value.trim().replace(/\s+/g, ' ')
  if (clean.length <= limit) {
    return clean
  }
  return `${clean.slice(0, limit - 1).trimEnd()}…`
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
  return result.slice(0, 5)
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

type BusyState = { message: string } | null
type QuestionDecision = {
  noteId: string
  index: number
  text: string
} | null

const tabs: Array<{ key: TabKey; label: string; short: string }> = [
  { key: 'capture', label: 'Voice', short: 'Voice' },
  { key: 'notes', label: 'Notizen', short: 'Notes' },
  { key: 'settings', label: 'Setup', short: 'Setup' },
]

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('capture')
  const [notes, setNotes] = useState<NoteNode[]>([])
  const [settings, setSettings] = useState<SettingsResponse | null>(null)
  const [selectedNoteId, setSelectedNoteId] = useState('')
  const [noteDraft, setNoteDraft] = useState('')
  const [appendDraft, setAppendDraft] = useState('')
  const [busy, setBusy] = useState<BusyState>(null)
  const [error, setError] = useState('')
  const [playingId, setPlayingId] = useState('')
  const [deleteNoteTarget, setDeleteNoteTarget] = useState<NoteNode | null>(null)
  const [deleteAllOpen, setDeleteAllOpen] = useState(false)
  const [questionDecision, setQuestionDecision] = useState<QuestionDecision>(null)
  const [settingsDraft, setSettingsDraft] = useState({
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
  const recorder = useVoiceRecorder()

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
    if (!recorder.error) {
      return
    }
    setError(recorder.error)
  }, [recorder.error])

  useEffect(() => {
    if (selectedNote) {
      setAppendDraft((current) => current)
    } else {
      setAppendDraft('')
    }
  }, [selectedNote?.id])

  useEffect(() => {
    if (!selectedNote) {
      setAppendDraft('')
    }
  }, [selectedNote])

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

  const startVoiceCapture = async (noteId?: string) => {
    if (recorder.isRecording) {
      return
    }
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
    const note = await updateNotesFromResponse(response)
    setActiveTab('notes')
    setSelectedNoteId(note.id)
  }

  const submitTextNote = async () => {
    const clean = noteDraft.trim()
    if (!clean) {
      setError('Bitte erst Text für die Notiz eingeben.')
      return
    }
    setNoteDraft('')
    const response = await runBusy('Textnotiz wird aufbereitet …', async () => api.createTextNote(clean))
    const note = await updateNotesFromResponse(response)
    setActiveTab('notes')
    setSelectedNoteId(note.id)
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
    setSelectedNoteId('')
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

  return (
    <div className="app-shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />
      <header className="topbar">
        <div>
          <p className="eyebrow">BrainSession PWA</p>
          <h1>Notes first. Voice when it matters.</h1>
        </div>
        <div className="status-chip">{noteCount === 1 ? '1 note' : `${noteCount} notes`}</div>
      </header>

      <main className="main-panel">
        {activeTab === 'capture' && (
          <CaptureView
            noteDraft={noteDraft}
            setNoteDraft={setNoteDraft}
            submitTextNote={submitTextNote}
            startVoiceCapture={() => void startVoiceCapture()}
            isRecording={recorder.isRecording}
          />
        )}

        {activeTab === 'notes' && (
          <NotesView
            notes={notes}
            selectedNote={selectedNote}
            selectedNoteId={selectedNoteId}
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
            backToList={() => setSelectedNoteId('')}
          />
        )}

        {activeTab === 'settings' && (
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
        )}
      </main>

      <nav className="bottom-nav">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={`nav-pill ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
            type="button"
          >
            <span>{tab.short}</span>
            <strong>{tab.label}</strong>
          </button>
        ))}
      </nav>

      {recorder.isRecording && (
        <RecordingOverlay
          levels={recorder.levels}
          onStop={() => void stopVoiceCapture()}
        />
      )}

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
          title="Notiz wirklich löschen?"
          message="Diese Notiz und alle dazugehörigen Audioaufnahmen werden dauerhaft entfernt."
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
          message="Das entfernt alle gespeicherten Notizen und Audioaufnahmen dauerhaft."
          confirmLabel="Alles löschen"
          cancelLabel="Abbrechen"
          destructive
          onConfirm={() => void deleteAllNotes()}
          onCancel={() => setDeleteAllOpen(false)}
        />
      )}
    </div>
  )
}

function CaptureView(props: {
  noteDraft: string
  setNoteDraft: (value: string) => void
  submitTextNote: () => void
  startVoiceCapture: () => void
  isRecording: boolean
}) {
  return (
    <section className="page capture-page">
      <div className="hero-card">
        <div className="hero-copy">
          <p className="eyebrow">Voice primary</p>
          <h2>Capture fast, read later.</h2>
          <p className="muted">Sprachmemos werden lokal aufgezeichnet und erst nach dem Stopp verarbeitet.</p>
        </div>
        <div className="hero-mark">BS</div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <p className="eyebrow">Textnotiz</p>
          <h3>Direkt als Text festhalten</h3>
        </div>
        <textarea
          className="textarea"
          value={props.noteDraft}
          onChange={(event) => props.setNoteDraft(event.target.value)}
          placeholder="Idee, Aufgabe oder Beobachtung notieren …"
          rows={7}
        />
        <button className="primary-button" onClick={props.submitTextNote} type="button" disabled={!props.noteDraft.trim() || props.isRecording}>
          Textnotiz anlegen
        </button>
      </div>

      <div className="record-bar">
        <button className={`record-button ${props.isRecording ? 'recording' : ''}`} onClick={props.startVoiceCapture} type="button" disabled={props.isRecording}>
          <span className="record-dot" />
          {props.isRecording ? 'Aufnahme läuft …' : 'Sprachnotiz aufnehmen'}
        </button>
      </div>
    </section>
  )
}

function NotesView(props: {
  notes: NoteNode[]
  selectedNote: NoteNode | null
  selectedNoteId: string
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
}) {
  if (!props.selectedNote) {
    return (
      <section className="page notes-page">
        <div className="notes-head">
          <h2>Notizen</h2>
        </div>
        {props.notes.length === 0 ? (
          <div className="empty-card">
            <h3>Noch keine Notizen vorhanden</h3>
            <p>Starte eine Sprachnotiz oder lege Text direkt an. Neue Notizen erscheinen danach automatisch hier.</p>
          </div>
        ) : (
          <div className="notes-list">
            {props.notes.map((note) => (
              <NoteCard
                key={note.id}
                note={note}
                playing={props.currentlyPlayingId === note.id}
                onOpen={() => props.setSelectedNoteId(note.id)}
                onTogglePlayback={() => {
                  const audioPath = note.audioRelativePath || note.entries.find((entry) => entry.audioRelativePath)?.audioRelativePath || ''
                  if (audioPath) {
                    props.onTogglePlayback(note.id, mediaUrl(audioPath))
                  }
                }}
              />
            ))}
          </div>
        )}
      </section>
    )
  }

  return (
    <section className="page detail-page">
      <div className="detail-header">
        <button className="secondary-button" onClick={props.backToList} type="button">
          Zurück
        </button>
        <button className="ghost-button" onClick={() => props.onOpenCaptureForNote(props.selectedNote!.id)} type="button">
          Sprachnotiz ergänzen
        </button>
      </div>

      <div className="panel detail-hero">
        <p className="eyebrow">Notiz</p>
        <h2>{props.selectedNote.title || 'Untitled Note'}</h2>
        <p className="muted">{formatRelativeDate(props.selectedNote.updatedAt)}</p>
      </div>

      <SummarySectionsCard
        note={props.selectedNote}
        onToggleTodo={props.toggleTodo}
        onDismissQuestion={props.dismissQuestion}
        onSetDecision={(index, text) => {
          props.dismissQuestion(index, 'schon beantwortet')
        }}
        onMarkQuestion={(index, text) => {
          props.dismissQuestion(index, 'unwichtig')
        }}
        onOpenQuestionDecision={(index, text) => {
          // handled internally by the card
        }}
      />

      {props.selectedNote.bullets.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <p className="eyebrow">Bullets</p>
            <h3>Kernaussagen</h3>
          </div>
          <ul className="bullet-list">
            {props.selectedNote.bullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <p className="eyebrow">Erweitern</p>
          <h3>Text an die Notiz anhängen</h3>
        </div>
        <textarea
          className="textarea"
          rows={5}
          value={props.appendDraft}
          onChange={(event) => props.setAppendDraft(event.target.value)}
          placeholder="Ergänzung eintippen …"
        />
        <button className="primary-button" onClick={props.appendTextToNote} type="button" disabled={!props.appendDraft.trim()}>
          Text anhängen
        </button>
      </div>

      {props.selectedNote.entries.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <p className="eyebrow">Timeline</p>
            <h3>Chronologie</h3>
          </div>
          <div className="entry-list">
            {props.selectedNote.entries.map((entry, index) => (
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
      )}

      <div className="panel actions-panel">
        <button className="primary-button" onClick={props.regenerateSummary} type="button">
          Zusammenfassung neu erstellen
        </button>
        <button className="danger-button" onClick={() => props.deleteNote(props.selectedNote!)} type="button">
          Notiz löschen
        </button>
      </div>
    </section>
  )
}

function NoteCard(props: {
  note: NoteNode
  onOpen: () => void
  onTogglePlayback: () => void
  playing: boolean
}) {
  const tags = uniqueTags(props.note.tags)
  const hasPending = props.note.entries.some((entry) => entry.transcriptionState === 'pending_retry')

  return (
    <div className="note-card" role="button" tabIndex={0} onClick={props.onOpen} onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        props.onOpen()
      }
    }}>
      <div className="note-card-top">
        <div>
          <p className="note-date">{formatRelativeDate(props.note.updatedAt)}</p>
          <h3>{props.note.title || 'Untitled Note'}</h3>
        </div>
        {props.note.audioRelativePath || props.note.entries.some((entry) => entry.audioRelativePath) ? (
          <span className={`mini-chip ${props.playing ? 'accent' : ''}`}>{props.playing ? 'Audio läuft' : 'Audio'}</span>
        ) : null}
      </div>
      <p className="note-summary">{preview(props.note.summary, 180) || 'Noch keine Zusammenfassung vorhanden.'}</p>
      <div className="chip-row">
        {tags.map((tag) => (
          <span className="mini-chip" key={tag}>
            {tag}
          </span>
        ))}
        {hasPending && <span className="mini-chip warning">Transkription offen</span>}
      </div>
      {(props.note.audioRelativePath || props.note.entries.some((entry) => entry.audioRelativePath)) && (
        <button
          className="secondary-button note-play-button"
          onClick={(event) => {
            event.stopPropagation()
            props.onTogglePlayback()
          }}
          type="button"
        >
          {props.playing ? 'Audio stoppen' : 'Audio abspielen'}
        </button>
      )}
    </div>
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
    <div className={`timeline-entry ${voice ? 'voice' : 'text'}`}>
      <div className="entry-head">
        <div>
          <p className="note-date">Eintrag {props.index + 1} · {formatRelativeDate(props.entry.createdAt)}</p>
        </div>
        <span className={`mini-chip ${voice ? 'accent' : ''}`}>{voice ? 'Sprachnachricht' : 'Textnachricht'}</span>
      </div>
      <p className="entry-text">{props.entry.transcript || '(leer)'}</p>
      {props.entry.transcriptionState === 'pending_retry' && (
        <div className="entry-warning">
          <p>{props.entry.transcriptionError || 'Die Transkription ist fehlgeschlagen. Die Audioaufnahme ist lokal gespeichert und kann erneut verarbeitet werden.'}</p>
          <button className="secondary-button" onClick={props.onRetry} type="button">
            Neu transkribieren
          </button>
        </div>
      )}
      {voice && props.entry.audioRelativePath && (
        <button className="secondary-button" onClick={props.onPlay} type="button">
          {props.playing ? 'Audio stoppen' : 'Audio abspielen'}
        </button>
      )}
    </div>
  )
}

function SummarySectionsCard(props: {
  note: NoteNode
  onToggleTodo: (index: number, checked: boolean) => void
  onDismissQuestion: (index: number, reason: 'schon beantwortet' | 'unwichtig') => void
  onSetDecision: (index: number, text: string) => void
  onMarkQuestion: (index: number, text: string) => void
  onOpenQuestionDecision: (index: number, text: string) => void
}) {
  const note = props.note
  const summarySections = note.summarySections
  const hasReviewed = note.followUpQuestionReviews.length > 0
  const sections = [
    { key: 'summary', label: 'Zusammenfassung' },
    ...(summarySections.todos.length > 0 ? [{ key: 'todos', label: 'To-dos' }] : []),
    ...(summarySections.milestones.length > 0 ? [{ key: 'milestones', label: 'Milestones / Ziele' }] : []),
    ...(summarySections.questions.length > 0 ? [{ key: 'questions', label: 'Folgefragen' }] : []),
    ...(hasReviewed ? [{ key: 'reviewed', label: 'Aussortiert' }] : []),
  ] as const
  const [selected, setSelected] = useState<(typeof sections)[number]['key']>(sections[0]?.key ?? 'summary')

  useEffect(() => {
    if (!sections.some((section) => section.key === selected)) {
      setSelected(sections[0]?.key ?? 'summary')
    }
  }, [note.id, sections.map((section) => section.key).join('|')])

  return (
    <div className="panel">
      <div className="panel-head">
        <p className="eyebrow">Struktur</p>
        <h3>Zusammenfassung, Aufgaben, Fortschritt und Folgefragen</h3>
      </div>
      <div className="chip-row">
        {sections.map((section) => (
          <button key={section.key} className={`mini-chip section-chip ${selected === section.key ? 'selected' : ''}`} type="button" onClick={() => setSelected(section.key)}>
            {section.label}
          </button>
        ))}
      </div>
      <div className="structured-box">
        {selected === 'summary' && <p className="summary-text">{note.summary || 'Noch keine Zusammenfassung vorhanden.'}</p>}
        {selected === 'todos' && (
          <div className="stack">
            {summarySections.todos.map((todo, index) => {
              const checked = summarySections.todoStates[index] === true
              return (
                <label className="todo-row" key={`${todo}-${index}`}>
                  <input type="checkbox" checked={checked} onChange={(event) => props.onToggleTodo(index, event.target.checked)} />
                  <span className={checked ? 'todo-done' : ''}>{todo}</span>
                </label>
              )
            })}
          </div>
        )}
        {selected === 'milestones' && (
          <ul className="bullet-list">
            {summarySections.milestones.map((milestone) => (
              <li key={milestone}>{milestone}</li>
            ))}
          </ul>
        )}
        {selected === 'questions' && (
          <div className="stack">
            {summarySections.questions.map((question, index) => (
              <QuestionCard key={`${question}-${index}`} noteId={note.id} question={question} index={index} onDismiss={props.onDismissQuestion} />
            ))}
          </div>
        )}
        {selected === 'reviewed' && (
          <div className="stack">
            {note.followUpQuestionReviews.map((review) => (
              <ReviewedQuestionCard key={`${review.question}-${review.createdAt}`} review={review} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function QuestionCard(props: {
  noteId: string
  question: string
  index: number
  onDismiss: (index: number, reason: 'schon beantwortet' | 'unwichtig') => void
}) {
  const [open, setOpen] = useState(false)
  const longPress = useLongPress(() => setOpen(true))

  return (
    <>
      <button className="question-card" type="button" {...longPress}>
        <p className="note-date">Folgefrage {props.index + 1}</p>
        <h4>{props.question}</h4>
      </button>
      {open && (
        <ConfirmationModal
          title="Folgefrage markieren?"
          message={props.question}
          confirmLabel="schon beantwortet"
          cancelLabel="unwichtig"
          onConfirm={() => {
            setOpen(false)
            props.onDismiss(props.index, 'schon beantwortet')
          }}
          onCancel={() => {
            setOpen(false)
            props.onDismiss(props.index, 'unwichtig')
          }}
        />
      )}
    </>
  )
}

function ReviewedQuestionCard(props: { review: FollowUpQuestionReview }) {
  return (
    <div className="review-card">
      <p className="note-date">{formatRelativeDate(props.review.createdAt)}</p>
      <h4>{props.review.reason}</h4>
      <p>{props.review.question}</p>
    </div>
  )
}

function SettingsView(props: {
  settings: SettingsResponse | null
  settingsDraft: {
    openAiApiKey: string
    openAiModel: string
    transcriptionModel: string
    summaryModel: string
    followUpModel: string
    language: string
  }
  setSettingsDraft: Dispatch<
    SetStateAction<{
      openAiApiKey: string
      openAiModel: string
      transcriptionModel: string
      summaryModel: string
      followUpModel: string
      language: string
    }>
  >
  saveSettings: () => void
  exportTechnicalReport: () => void
  reportStatus: string
  reportDownload: string
  deleteAllNotes: () => void
}) {
  return (
    <section className="page settings-page">
      <div className="panel">
        <div className="panel-head">
          <p className="eyebrow">Setup</p>
          <h2>Technik bleibt im Hintergrund</h2>
        </div>
        <div className="settings-grid">
          <label className="field">
            <span>OpenAI API Key</span>
            <input
              type="password"
              value={props.settingsDraft.openAiApiKey}
              onChange={(event) => props.setSettingsDraft((current) => ({ ...current, openAiApiKey: event.target.value }))}
              placeholder={props.settings?.openAiApiKeyPresent ? 'Vorhandener Key bleibt gespeichert, wenn leer gelassen' : 'API Key eingeben'}
            />
          </label>
          <label className="field">
            <span>OpenAI Modell</span>
            <input
              type="text"
              value={props.settingsDraft.openAiModel}
              onChange={(event) => props.setSettingsDraft((current) => ({ ...current, openAiModel: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>Transcription Modell</span>
            <input
              type="text"
              value={props.settingsDraft.transcriptionModel}
              onChange={(event) => props.setSettingsDraft((current) => ({ ...current, transcriptionModel: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>Summary Modell</span>
            <input
              type="text"
              value={props.settingsDraft.summaryModel}
              onChange={(event) => props.setSettingsDraft((current) => ({ ...current, summaryModel: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>Follow-up Modell</span>
            <input
              type="text"
              value={props.settingsDraft.followUpModel}
              onChange={(event) => props.setSettingsDraft((current) => ({ ...current, followUpModel: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>Sprache</span>
            <input
              type="text"
              value={props.settingsDraft.language}
              onChange={(event) => props.setSettingsDraft((current) => ({ ...current, language: event.target.value }))}
            />
          </label>
        </div>
        <div className="button-row">
          <button className="primary-button" onClick={props.saveSettings} type="button">
            Speichern
          </button>
          <button className="secondary-button" onClick={props.exportTechnicalReport} type="button">
            Technischen Report exportieren
          </button>
          <button className="danger-button" onClick={props.deleteAllNotes} type="button">
            Alle Notizen löschen
          </button>
        </div>
        {props.reportStatus && <p className="report-status">{props.reportStatus}</p>}
        {props.reportDownload && <p className="report-status">{props.reportDownload}</p>}
      </div>
      <div className="panel">
        <div className="panel-head">
          <p className="eyebrow">Status</p>
          <h3>Server-Info</h3>
        </div>
        <div className="status-grid">
          <div>
            <span className="status-label">OpenAI-Key</span>
            <strong>{props.settings?.openAiApiKeyPresent ? 'gesetzt' : 'nicht gesetzt'}</strong>
          </div>
          <div>
            <span className="status-label">Data dir</span>
            <strong>{props.settings?.dataDir ?? '...'}</strong>
          </div>
          <div>
            <span className="status-label">Media dir</span>
            <strong>{props.settings?.mediaDir ?? '...'}</strong>
          </div>
        </div>
      </div>
    </section>
  )
}

function RecordingOverlay(props: { levels: number[]; onStop: () => void }) {
  const visibleLevels = [...Array(30)].map((_, index) => props.levels[index] ?? 0)
  return (
    <div className="overlay">
      <div className="overlay-card recording-card">
        <div className="overlay-header">
          <div>
            <p className="eyebrow">Aufnahme läuft</p>
            <h3>Die letzten Sekunden werden live angezeigt.</h3>
          </div>
          <span className="status-chip live">LIVE</span>
        </div>
        <div className="equalizer" aria-hidden="true">
          {visibleLevels.map((level, index) => (
            <span key={index} className="eq-bar" style={{ height: `${Math.max(10, 12 + level * 100)}%`, opacity: 0.45 + level * 0.55 }} />
          ))}
        </div>
        <button className="primary-button" onClick={props.onStop} type="button">
          Stop
        </button>
      </div>
    </div>
  )
}

function LoadingOverlay(props: { message: string }) {
  return (
    <div className="overlay">
      <div className="overlay-card loading-card">
        <div className="spinner" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <h3>{props.message}</h3>
        <p>Die Verarbeitung läuft noch im Hintergrund.</p>
      </div>
    </div>
  )
}

function ErrorOverlay(props: { message: string; onDismiss: () => void }) {
  return (
    <div className="overlay">
      <div className="overlay-card error-card">
        <div className="warning-mark">!</div>
        <h3>Etwas hat nicht geklappt</h3>
        <p>{props.message}</p>
        <button className="primary-button" onClick={props.onDismiss} type="button">
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
    <div className="overlay">
      <div className="overlay-card confirm-card">
        <h3>{props.title}</h3>
        <p>{props.message}</p>
        <div className="button-row">
          <button className={props.destructive ? 'danger-button' : 'primary-button'} onClick={props.onConfirm} type="button">
            {props.confirmLabel}
          </button>
          <button className="secondary-button" onClick={props.onCancel} type="button">
            {props.cancelLabel}
          </button>
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
    <div className="overlay">
      <div className="overlay-card confirm-card">
        <p className="eyebrow">Folgefrage markieren?</p>
        <h3>{props.question.text}</h3>
        <div className="button-row">
          <button className="primary-button" onClick={() => props.onDismiss('schon beantwortet')} type="button">
            schon beantwortet
          </button>
          <button className="secondary-button" onClick={() => props.onDismiss('unwichtig')} type="button">
            unwichtig
          </button>
        </div>
        <button className="ghost-button" onClick={props.onClose} type="button">
          Abbrechen
        </button>
      </div>
    </div>
  )
}
