import { useCallback, useEffect, useState } from 'react'
import Admin from './Admin.tsx'
import { CardPage } from './CardView.tsx'
import Creator from './Creator.tsx'
import type { CardToOpen } from './host.ts'
import Library from './Library.tsx'
import { getHealth, getLibrary, readAsAdmin } from './library.ts'
import type { Health, LibraryIndex } from './library.ts'
import Overview from './Overview.tsx'
import { getSession, signOut } from './review.ts'
import type { Session } from './review.ts'
import { go, useRoute } from './route.ts'
import Validate from './Validate.tsx'

export default function App() {
  const route = useRoute()
  const [health, setHealth] = useState<Health | null>(null)
  const [library, setLibrary] = useState<LibraryIndex | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [creatorOpened, setCreatorOpened] = useState(false) // the frame is loaded on first visit, then kept
  const [toOpen, setToOpen] = useState<CardToOpen | null>(null)
  const [wide, setWide] = useState(false) // an author is going through their card section by section
  // Admin mode: a signed-in administrator also sees the drafts, and the pages that manage the cards.
  const [session, setSession] = useState<Session | null>(null)
  const admin = session?.signed_in ?? false

  useEffect(() => {
    getHealth().then(setHealth, () => setFailure('Cannot reach the server.'))
    getSession().then(setSession, () => setSession({ configured: false, signed_in: false }))
  }, [])

  const reload = useCallback(() => void getLibrary().then((index) => (setLibrary(index), setFailure(null)), () => undefined), [])

  // The library is read once it is known who is looking: administrators get the drafts too.
  useEffect(() => {
    if (!session) return
    readAsAdmin(session.signed_in)
    setLibrary(null)
  }, [session])

  // While the server is still reading the cards from ATLAS for the first time, ask again every few seconds.
  useEffect(() => {
    if (!session || (library && (library.count > 0 || !library.syncing))) return
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
  }, [library, session])

  useEffect(() => {
    if (route.page === 'creator') setCreatorOpened(true)
  }, [route.page])

  const edit = useCallback((card: CardToOpen) => {
    setToOpen(card)
    go('#/creator')
  }, [])
  const opened = useCallback(() => setToOpen(null), [])
  const leave = () => {
    const out = () => (setSession({ configured: true, signed_in: false }), go('#/library'))
    signOut().then(out, out)
  }

  const creator = health?.creator_url ? { url: health.creator_url, origin: health.creator_origin } : null
  const current = (page: string) => (route.page === page || (page === 'library' && route.page === 'card') ? 'current' : '')
  const desk = (tab: string) => (route.page === 'admin' && route.id === tab ? 'current' : '')

  return (
    <div className={`page ${route.page === 'creator' || (route.page === 'validate' && wide) ? 'full' : ''}`}>
      <header>
        <div>
          <h1>
            <a className="home" href="#/library" title="Back to the start: every card, no filters">
              ATLAS <span className="version">V2 proposal</span>
            </a>
          </h1>
          <p className="muted">
            A proposal for how RSNA ATLAS could present its model and dataset cards. The cards are read from atlas.rsna.org
            {library?.cards.some((card) => card.origin === 'new') && ', plus new cards drafted from published papers and marked as new'}; this is
            not the official ATLAS site.
          </p>
        </div>
      </header>

      {route.page !== 'validate' && (
        <nav className="site-nav" aria-label="Pages">
          <a href="#/library" className={current('library')}>Browse</a>
          <a href="#/overview" className={current('overview')}>Overview</a>
          {creator && <a href="#/creator" className={current('creator')}>Creator</a>}
          {admin ? (
            <span className="aside admin-nav">
              <span className="admin-mode" title="You are signed in as administrator: you also see the drafts, which visitors do not">Admin mode</span>
              <a href="#/admin" className={desk('')}>Author review</a>
              <a href="#/admin/cards" className={desk('cards')}>Cards</a>
              <a href="#/admin/submissions" className={desk('submissions')}>Submissions</a>
              <button type="button" className="link" onClick={leave}>Sign out</button>
            </span>
          ) : (
            <a href="#/admin" className={`${current('admin')} aside`}>Admin</a>
          )}
        </nav>
      )}

      {route.page === 'library' && <Library index={library} failure={failure} params={route.params} />}
      {route.page === 'card' && <CardPage id={route.id} onEdit={creator ? edit : null} admin={admin} onChanged={reload} />}
      {route.page === 'overview' && <Overview index={library} failure={failure} />}
      {route.page === 'admin' && <Admin session={session} onSession={setSession} tab={route.id} onChanged={reload} />}
      {route.page === 'validate' && <Validate token={route.id} creator={creator} onWide={setWide} />}
      {creator && creatorOpened && (
        <Creator url={creator.url} origin={creator.origin} hidden={route.page !== 'creator'} toOpen={toOpen} onOpened={opened}
          admin={admin} onSent={reload} />
      )}
    </div>
  )
}
