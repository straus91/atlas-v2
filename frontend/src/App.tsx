import { useCallback, useEffect, useMemo, useState } from 'react'
import Admin from './Admin.tsx'
import { CardPage } from './CardView.tsx'
import Creator from './Creator.tsx'
import { asDraft, readDrafts, writeDrafts } from './drafts.ts'
import type { CardToOpen, ReceivedCard } from './host.ts'
import Library from './Library.tsx'
import { describeCard, getHealth, getLibrary, setLocalRecords } from './library.ts'
import type { Health, LibraryCard, LibraryIndex, LibraryRecord } from './library.ts'
import Overview from './Overview.tsx'
import { go, useRoute } from './route.ts'
import Validate from './Validate.tsx'

export default function App() {
  const route = useRoute()
  const [health, setHealth] = useState<Health | null>(null)
  const [library, setLibrary] = useState<LibraryIndex | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [creatorOpened, setCreatorOpened] = useState(false) // the frame is loaded on first visit, then kept
  const [toOpen, setToOpen] = useState<CardToOpen | null>(null)
  // Cards sent from the creator; this browser only. Registered at once, so a draft's own page can be opened directly.
  const [drafts, setDrafts] = useState<LibraryRecord[]>(() => {
    const saved = readDrafts()
    setLocalRecords(saved)
    return saved
  })
  const [arrived, setArrived] = useState<{ id: string; name: string; description: string; cardType: string } | null>(null)

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

  // Drafts are looked up in this browser instead of on the server, and remembered between visits.
  useEffect(() => {
    setLocalRecords(drafts)
    writeDrafts(drafts)
  }, [drafts])

  /** A card arrived from the creator: have the server describe it, then keep it as a draft here. */
  const receive = useCallback(async (received: ReceivedCard) => {
    const draft = asDraft(await describeCard(received.card, received.description))
    setDrafts((current) => [draft, ...current])
    setArrived({ id: draft.facts!.id, name: draft.facts!.title, description: received.description, cardType: received.cardType })
  }, [])

  const removeDraft = useCallback((id: string) => {
    setDrafts((current) => current.filter((draft) => draft.facts?.id !== id))
    setArrived((current) => (current?.id === id ? null : current))
    go('#/library')
  }, [])

  const edit = useCallback((card: CardToOpen) => {
    setToOpen(card)
    go('#/creator')
  }, [])
  const opened = useCallback(() => setToOpen(null), [])
  /** The administrator gave or removed a mark: show it in Browse without a reload. */
  const reload = useCallback(() => void getLibrary().then(setLibrary, () => undefined), [])
  const dismiss = useCallback(() => setArrived(null), [])

  // Browse shows the published cards plus this visitor's drafts; the Overview counts published cards only.
  const browsing = useMemo<LibraryIndex | null>(() => {
    if (!library) return null
    const mine = drafts.map((draft) => draft.facts).filter((facts): facts is LibraryCard => facts !== null)
    return mine.length ? { ...library, cards: [...mine, ...library.cards] } : library
  }, [library, drafts])

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

      {route.page !== 'validate' && (
        <nav className="site-nav" aria-label="Pages">
          <a href="#/library" className={current('library')}>Browse</a>
          <a href="#/overview" className={current('overview')}>Overview</a>
          {creator && <a href="#/creator" className={current('creator')}>Creator</a>}
          <a href="#/admin" className={`${current('admin')} aside`}>Admin</a>
        </nav>
      )}

      {route.page === 'library' && <Library index={browsing} failure={failure} params={route.params} />}
      {route.page === 'card' && <CardPage id={route.id} onEdit={creator ? edit : null} onRemoveDraft={removeDraft} />}
      {route.page === 'overview' && <Overview index={library} failure={failure} />}
      {route.page === 'admin' && <Admin onMarksChanged={reload} />}
      {route.page === 'validate' && <Validate token={route.id} />}
      {creator && creatorOpened && (
        <Creator url={creator.url} origin={creator.origin} hidden={route.page !== 'creator'} toOpen={toOpen} onOpened={opened}
          arrived={arrived} onCard={receive} onDismiss={dismiss} />
      )}
    </div>
  )
}
