import { Component, StrictMode } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './base.css'
import './library.css'
import App from './App.tsx'

/** If something unexpected breaks, say so instead of showing a blank page. */
class Safety extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="page">
        <h1>ATLAS V2 proposal</h1>
        <p className="banner bad">Something went wrong on this page.</p>
        <button type="button" className="primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Safety>
      <App />
    </Safety>
  </StrictMode>,
)
