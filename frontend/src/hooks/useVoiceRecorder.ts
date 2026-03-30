import { useCallback, useEffect, useRef, useState } from 'react'

export interface RecordedBlob {
  blob: Blob
  mimeType: string
}

function pickMimeType(): string {
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  for (const candidate of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(candidate)) {
      return candidate
    }
  }
  return ''
}

export function useVoiceRecorder() {
  const [isRecording, setIsRecording] = useState(false)
  const [levels, setLevels] = useState<number[]>([])
  const [error, setError] = useState('')
  const [microphoneHint, setMicrophoneHint] = useState('')
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const mimeTypeRef = useRef('')
  const resolveRef = useRef<((value: RecordedBlob | null) => void) | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const animationRef = useRef<number | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const historyRef = useRef<number[]>([])

  useEffect(() => {
    let cancelled = false

    const inspectMicrophoneAvailability = async () => {
      if (typeof window === 'undefined') {
        return
      }
      if (!window.isSecureContext) {
        if (!cancelled) {
          setMicrophoneHint('Mikrofonzugriff braucht HTTPS oder localhost. Öffne die installierte HTTPS-URL statt der HTTP-Version.')
        }
        return
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        if (!cancelled) {
          setMicrophoneHint('Dieser Browser unterstützt keine Mikrofonaufnahme.')
        }
        return
      }
      if (!navigator.permissions?.query) {
        if (!cancelled) {
          setMicrophoneHint('Browser-Berechtigungen können nicht vorab geprüft werden. Tippe auf Aufnahme, um die Anfrage auszulösen.')
        }
        return
      }

      try {
        const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName })
        if (cancelled) {
          return
        }
        if (permission.state === 'denied') {
          setMicrophoneHint('Mikrofonzugriff ist im Browser blockiert. Bitte in den Website-Berechtigungen von Chrome erlauben.')
        } else {
          setMicrophoneHint('')
        }
      } catch {
        if (!cancelled) {
          setMicrophoneHint('')
        }
      }
    }

    void inspectMicrophoneAvailability()

    return () => {
      cancelled = true
    }
  }, [])

  const stopMeter = useCallback(() => {
    if (animationRef.current !== null) {
      window.cancelAnimationFrame(animationRef.current)
      animationRef.current = null
    }
    analyserRef.current = null
    historyRef.current = []
    setLevels([])
    if (audioContextRef.current) {
      void audioContextRef.current.close()
      audioContextRef.current = null
    }
  }, [])

  const startMeter = useCallback((stream: MediaStream) => {
    const context = new AudioContext()
    const source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)
    audioContextRef.current = context
    analyserRef.current = analyser

    const tick = () => {
      const node = analyserRef.current
      if (!node) {
        return
      }
      const data = new Uint8Array(node.fftSize)
      node.getByteTimeDomainData(data)
      const sum = data.reduce((accumulator, value) => {
        const centered = value - 128
        return accumulator + centered * centered
      }, 0)
      const rms = Math.sqrt(sum / data.length) / 128
      historyRef.current = [...historyRef.current.slice(-29), Math.min(1, Math.max(0, rms * 2.2))]
      setLevels(historyRef.current)
      animationRef.current = window.requestAnimationFrame(tick)
    }

    animationRef.current = window.requestAnimationFrame(tick)
  }, [])

  const cleanup = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    recorderRef.current = null
    stopMeter()
    setIsRecording(false)
  }, [stopMeter])

  const startRecording = useCallback(async () => {
    if (isRecording) {
      return
    }
    if (microphoneHint) {
      throw new Error(microphoneHint)
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Aufnahme wird von diesem Browser nicht unterstützt')
    }
    setError('')
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    const mimeType = pickMimeType()
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
    const chunks: BlobPart[] = []
    chunksRef.current = chunks
    mimeTypeRef.current = recorder.mimeType || mimeType || 'audio/webm'
    streamRef.current = stream
    recorderRef.current = recorder
    startMeter(stream)

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data)
      }
    }

    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current || 'audio/webm' })
      cleanup()
      resolveRef.current?.({ blob, mimeType: mimeTypeRef.current || blob.type || 'audio/webm' })
      resolveRef.current = null
    }

    recorder.onerror = () => {
      setError('Die Aufnahme konnte nicht gestartet werden.')
      cleanup()
      resolveRef.current?.(null)
      resolveRef.current = null
    }

    recorder.start()
    setIsRecording(true)
  }, [cleanup, isRecording, microphoneHint, startMeter])

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current
    if (!recorder) {
      return null
    }
    const result = new Promise<RecordedBlob | null>((resolve) => {
      const previous = resolveRef.current
      resolveRef.current = (value) => {
        previous?.(value)
        resolve(value)
      }
    })
    if (recorder.state !== 'inactive') {
      recorder.stop()
    } else {
      cleanup()
      resolveRef.current?.(null)
      resolveRef.current = null
    }
    return result
  }, [cleanup])

  useEffect(() => {
    return () => {
      cleanup()
    }
  }, [cleanup])

  return {
    isRecording,
    levels,
    error,
    microphoneHint,
    setError,
    startRecording,
    stopRecording,
  }
}
