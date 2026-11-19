// The Creator page: the card creator (a separate site) in a frame, as on the real ATLAS, plus
// what ATLAS does not have today: the finished card arrives here by itself.

import { useEffect, useRef, useState } from 'react'
import { listenToCreator, openInCreator } from './host.ts'
import type { CardToOpen, ReceivedCard } from './host.ts'
import { saveCard } from './library.ts'

interface CreatorProps {
  url: string
  origin: string
  hidden: boolean
  /** A card from the library to open for editing, once the creator is ready. */
  toOpen: CardToOpen | null
  onOpened: () => void
  received: ReceivedCard | null
  onReceived: (received: ReceivedCard | null) => void
}

export default function Creator({ url, origin, hidden, toOpen, onOpened, received, onReceived }: CreatorProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(
    () => listenToCreator(() => frame.current?.contentWindow ?? null, origin, {
      onReady: () => setReady(true),
      onCard: (card) => {
        onReceived(card)
        window.scrollTo({ top: 0, behavior: 'smooth' })
      },
    }),
    [origin, onReceived],
  )

  useEffect(() => {
    if (!ready || !toOpen || !frame.current?.contentWindow) return
    openInCreator(frame.current.contentWindow, origin, toOpen)
    onOpened()
  }, [ready, toOpen, origin, onOpened])

  const name = received ? String((received.card[received.cardType === 'dataset' ? 'Dataset' : 'Model'] as Record<string, unknown> | undefined)?.Name ?? 'Unnamed card') : ''

  return (
    <div hidden={hidden}>
      {received && (
        <section className="panel received" aria-live="polite">
          <h2>Card received: {name}</h2>
          <p className="muted">The card creator sent this {received.cardType} card and its description. No file was downloaded or uploaded.</p>
          <p className="description">{received.description || 'No description was given.'}</p>
          <div className="row">
            <a className="button primary" href="#/received">See it as a library page</a>
            <button type="button" onClick={() => saveCard(received.card, name, received.cardType)}>Download card (JSON)</button>
            <button type="button" onClick={() => onReceived(null)}>Dismiss</button>
          </div>
          <p className="muted draft-note">
            This proposal site has no accounts, so the card is kept only in this browser tab. In ATLAS this step would save it as your draft.
          </p>
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
