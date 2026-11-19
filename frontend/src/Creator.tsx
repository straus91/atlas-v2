// The Creator page: the card creator (a separate site) in a frame, as on the real ATLAS, plus
// what ATLAS does not have today: the finished card arrives here by itself.

import { useEffect, useRef, useState } from 'react'
import { listenToCreator, openInCreator } from './host.ts'
import type { CardToOpen, ReceivedCard } from './host.ts'

interface CreatorProps {
  url: string
  origin: string
  hidden: boolean
  /** A card from the library to open for editing, once the creator is ready. */
  toOpen: CardToOpen | null
  onOpened: () => void
  /** The card that just arrived, once it has been added to Browse as a draft. */
  arrived: { id: string; name: string; description: string; cardType: string } | null
  onCard: (received: ReceivedCard) => Promise<void>
  onDismiss: () => void
}

export default function Creator({ url, origin, hidden, toOpen, onOpened, arrived, onCard, onDismiss }: CreatorProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const [trouble, setTrouble] = useState<string | null>(null)

  useEffect(
    () => listenToCreator(() => frame.current?.contentWindow ?? null, origin, {
      onReady: () => setReady(true),
      onCard: (card) => {
        setTrouble(null)
        onCard(card).then(
          () => window.scrollTo({ top: 0, behavior: 'smooth' }),
          () => setTrouble('The card arrived, but it could not be added to Browse. Check the connection and send it again.'),
        )
      },
    }),
    [origin, onCard],
  )

  useEffect(() => {
    if (!ready || !toOpen || !frame.current?.contentWindow) return
    openInCreator(frame.current.contentWindow, origin, toOpen)
    onOpened()
  }, [ready, toOpen, origin, onOpened])

  return (
    <div hidden={hidden}>
      {trouble && <p className="banner bad">{trouble}</p>}
      {arrived && (
        <section className="panel received" aria-live="polite">
          <h2>Card received: {arrived.name}</h2>
          <p className="muted">
            The card creator sent this {arrived.cardType} card and its description. No file was downloaded or uploaded. It is now in Browse as
            a draft.
          </p>
          <p className="description">{arrived.description || 'No description was given.'}</p>
          <div className="row">
            <a className="button primary" href={`#/library/${arrived.id}`}>Open its page</a>
            <a className="button" href="#/library?status=Draft+%28only+in+this+browser%29">See it in Browse</a>
            <button type="button" onClick={onDismiss}>Dismiss</button>
          </div>
          <p className="muted draft-note">
            This proposal site has no accounts, so the draft is kept in this browser and only you can see it. In ATLAS this step would save it
            as a draft in your account.
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
