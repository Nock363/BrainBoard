import React from 'react'
import ReactDOM from 'react-dom/client'
import 'bootstrap/dist/css/bootstrap.min.css'
import 'bootstrap-icons/font/bootstrap-icons.css'
import App from './App'
import './styles.css'

const isDesktopRoute = window.location.pathname === '/desktop' || window.location.pathname.startsWith('/desktop/')

if ('serviceWorker' in navigator && !isDesktopRoute) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override componentDidCatch(error: Error) {
    console.error('BrainSession render error', error)
  }

  override render() {
    const error = this.state.error
    if (error) {
      return (
        <div className="bootstrap-app text-body d-flex align-items-center justify-content-center min-vh-100 p-3">
          <div className="modal-panel p-4 w-100" style={{ maxWidth: '42rem' }}>
            <p className="small text-uppercase text-secondary fw-semibold mb-1">BrainSession</p>
            <h1 className="h4 mb-3">Die App ist beim Laden abgestürzt</h1>
            <p className="text-secondary mb-3">{error.message}</p>
            <pre className="transcript-box mb-0" style={{ whiteSpace: 'pre-wrap' }}>{error.stack || 'Kein Stacktrace verfügbar.'}</pre>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
)
