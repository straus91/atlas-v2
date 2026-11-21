// The Creator page: the card creator (a separate site) in a frame, as on the real ATLAS, plus
// what ATLAS does not have today: the finished card arrives here by itself, and is sent on for
// review without a file being downloaded or uploaded.

import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { listenToCreator, openInCreator } from './host.ts'
import type { CardToOpen, ReceivedCard } from './host.ts'
import { submitCard } from './library.ts'
import { isAddress } from './review.ts'

interface CreatorProps {
  url: string
  origin: string
  hidden: boolean
  /** A card from the library to open for editing, once the creator is ready. */
  toOpen: CardToOpen | null
  onOpened: () => void
  /** A signed-in administrator, who can go straight to the submitted card. */
  admin: boolean
  /** A card was sent for review. */
  onSent: () => void
}

const nameOf = (received: ReceivedCard) => {
  const body = (received.card.Dataset ?? received.card.Model ?? {}) as Record<string, unknown>
  return typeof body.Name === 'string' && body.Name.trim() ? body.Name.trim() : `Untitled ${received.cardType}`
}

export default function Creator({ url, origin, hidden, toOpen, onOpened, admin, onSent }: CreatorProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const [received, setReceived] = useState<ReceivedCard | null>(null) // arrived from the creator, not sent on yet
  const [sent, setSent] = useState<string | null>(null) // the title of the card just sent for review
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [trouble, setTrouble] = useState<string | null>(null)

  useEffect(
    () => listenToCreator(() => frame.current?.contentWindow ?? null, origin, {
      onReady: () => setReady(true),
      onCard: (card) => {
        setTrouble(null)
        setSent(null)
        setReceived(card)
        window.scrollTo({ top: 0, behavior: 'smooth' })
      },
    }),
    [origin],
  )

  useEffect(() => {
    if (!ready || !toOpen || !frame.current?.contentWindow) return
    openInCreator(frame.current.contentWindow, origin, toOpen)
    onOpened()
  }, [ready, toOpen, origin, onOpened])

  const send = (event: FormEvent) => {
    event.preventDefault()
    if (!received) return
    if (email.trim() && !isAddress(email)) {
      setTrouble('That is not an email address. Correct it, or leave the box empty.')
      return
    }
    setBusy(true)
    setTrouble(null)
    submitCard(received.card, received.description, name, email).then(
      (answer) => {
        setBusy(false)
        setSent(answer.title || nameOf(received))
        setReceived(null)
        onSent()
      },
      (error: Error) => {
        setBusy(false)
        setTrouble(error.message)
      },
    )
  }

  return (
    <div hidden={hidden}>
      {received && (
        <form className="panel received" aria-live="polite" onSubmit={send}>
          <h2>Card received: {nameOf(received)}</h2>
          <p className="muted">
            The card creator handed over this {received.cardType} card and its description. No file was downloaded or uploaded. Send it for
            review: an administrator looks at it before it appears in the library.
          </p>
          <p className="description">{received.description || 'No description was given.'}</p>
          <div className="sender">
            <label>
              Your name <span className="muted">(optional)</span>
              <input type="text" value={name} maxLength={200} autoComplete="name" onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              Your email <span className="muted">(optional, only the administrators see it)</span>
              <input type="email" value={email} maxLength={320} autoComplete="email" onChange={(event) => (setEmail(event.target.value), setTrouble(null))} />
            </label>
          </div>
          {trouble && <p className="banner bad" role="alert">{trouble}</p>}
          <div className="row">
            <button type="submit" className="primary" disabled={busy}>{busy ? 'Sending…' : 'Send for review'}</button>
            <button type="button" disabled={busy} onClick={() => (setReceived(null), setTrouble(null))}>Discard</button>
          </div>
          <p className="muted draft-note">
            This proposal site has no accounts, so a card sent here waits as a draft that only the administrators see. In ATLAS this step
            would save it in your own account.
          </p>
        </form>
      )}
      {sent && (
        <section className="panel received" aria-live="polite">
          <h2>Sent for review: {sent}</h2>
          <p>The card is with the administrators now. It appears in the library once one of them publishes it.</p>
          <div className="row">
            {admin && <a className="button primary" href="#/admin/submissions">Open Submissions</a>}
            <button type="button" onClick={() => setSent(null)}>Dismiss</button>
          </div>
        </section>
      )}
      <iframe ref={frame} className="creator-frame" src={url} title="ROADMAP Card Creator"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals" />
      <p className="muted fine">
        The card creator is a separate site ({origin.replace(/^https?:\/\//, '')}) shown here in a frame.
        {ready ? ' Connected: “Send to ATLAS” in the creator hands the finished card to this page.' : ' Connecting…'}
      </p>
    </div>
  )
}
