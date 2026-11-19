import { useCallback, useEffect, useState } from 'react'
import { CardBody, CardPage } from './CardView.tsx'
import Creator from './Creator.tsx'
import type { CardToOpen, ReceivedCard } from './host.ts'
import Library from './Library.tsx'
import { describeCard, getHealth, getLibrary } from './library.ts'
import type { Health, LibraryIndex, LibraryRecord } from './library.ts'
import Overview from './Overview.tsx'
import { go, useRoute } from './route.ts'

export default function App() {
  const route = useRoute()
  const [health, setHealth] = useState<Health | null>(null)
  const [library, setLibrary] = useState<LibraryIndex | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [creatorOpened, setCreatorOpened] = useState(false) // the frame is loaded on first visit, then kept
  const [toOpen, setToOpen] = useState<CardToOpen | null>(null)
  const [received, setReceived] = useState<ReceivedCard | null>(null)
  const [preview, setPreview] = useState<LibraryRecord | null>(null)

  useEffect(() => {
    getHealth().then(setHealth, () => setFailure('Cannot reach the server.'))
  }, [])

  // While the server is still reading the cards from ATLAS for the first time, ask again every few seconds.
  useEffect(() => {
    if (library && (library.count > 0 || !library.syncing)) return
    let current = true
    const load = () =>
      getLibrary().then(
        (index) => current && (setLibrary(index), setFailure(null)),
        (error: Error) => current && setFailure(error.message),
      )
    const timer = setTimeout(load, library ? 5000 : 0)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [library])

  useEffect(() => {
    if (route.page === 'creator') setCreatorOpened(true)
  }, [route.page])

  // A card that just arrived from the creator, described the way the library describes its cards.
  useEffect(() => {
    setPreview(null)
    if (!received) return
    let current = true
    describeCard(received.card, received.description).then((record) => current && setPreview(record), () => undefined)
    return () => {
      current = false
    }
  }, [received])

  const edit = useCallback((card: CardToOpen) => {
    setToOpen(card)
    go('#/creator')
  }, [])
  const opened = useCallback(() => setToOpen(null), [])

  const creator = health?.creator_url ? { url: health.creator_url, origin: health.creator_origin } : null
  const current = (page: string) => (route.page === page || (page === 'library' && route.page === 'card') ? 'current' : '')

  return (
    <div className={`page ${route.page === 'creator' ? 'full' : ''}`}>
      <header>
        <div>
          <h1>
            ATLAS <span className="version">V2 proposal</span>
          </h1>
          <p className="muted">
            A proposal for how RSNA ATLAS could present its model and dataset cards. The cards are read from atlas.rsna.org; this is not the
            official ATLAS site.
          </p>
        </div>
      </header>

      <nav className="site-nav" aria-label="Pages">
        <a href="#/library" className={current('library')}>Browse</a>
        <a href="#/overview" className={current('overview')}>Overview</a>
        {creator && <a href="#/creator" className={current('creator')}>Creator</a>}
      </nav>

      {route.page === 'library' && <Library index={library} failure={failure} params={route.params} />}
      {route.page === 'card' && <CardPage id={route.id} onEdit={creator ? edit : null} />}
      {route.page === 'overview' && <Overview index={library} failure={failure} />}
      {route.page === 'received' &&
        (preview ? (
          <>
            <p className="banner warn">
              This card was just received from the card creator and exists only in this browser tab. This is how it would look in the library.
            </p>
            <CardBody record={preview} onEdit={creator ? edit : null} backTo="#/creator" backLabel="Creator" />
          </>
        ) : (
          <p className="panel muted">No card has been received from the creator in this tab. <a href="#/creator">Open the Creator</a>.</p>
        ))}
      {creator && creatorOpened && (
        <Creator url={creator.url} origin={creator.origin} hidden={route.page !== 'creator'} toOpen={toOpen} onOpened={opened}
          received={received} onReceived={setReceived} />
      )}
    </div>
  )
}
