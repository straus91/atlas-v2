// Admin mode: the new cards and their status. A draft is hidden from visitors; a published card
// is in the library for everyone. Two lists share this page: "Cards" (added from a file) and
// "Submissions" (sent by anyone from the Creator page, always arriving as drafts).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { TypeBadge } from './Library.tsx'
import { day } from './library.ts'
import { SignedOut, addNewCards, getAdminCards, readNewCards, removeCards, removeNewCards, setCardStatus } from './review.ts'
import type { ManagedCard } from './review.ts'

type Source = 'file' | 'submission'
type StatusFilter = 'all' | 'draft' | 'published'

interface DeskProps {
  source: Source
  /** The library changed: Browse and the Overview should read it again. */
  onChanged: () => void
  onSignedOut: () => void
}

const STAGE_WORDS: Record<string, string> = {
  requested: 'Contact asked', confirmed: 'Confirmed, waits for your OK', edited: 'Corrected, waits for your OK', changes: 'Changes asked', approved: 'Author-reviewed',
}

export default function CardsDesk({ source, onChanged, onSignedOut }: DeskProps) {
  const [rows, setRows] = useState<ManagedCard[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [chosen, setChosen] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string[] | null>(null) // ids waiting for a yes

  const failed = useCallback((error: Error) => {
    setBusy(false)
    if (error instanceof SignedOut) onSignedOut()
    else setFailure(error.message)
  }, [onSignedOut])
  const load = useCallback(() => getAdminCards().then((cards) => (setRows(cards), setFailure(null)), failed), [failed])
  useEffect(() => void load(), [load])
  useEffect(() => (setChosen([]), setNote(null), setDeleting(null), setStatus('all'), setText('')), [source])

  const mine = useMemo(() => (rows ?? []).filter((row) => row.source === source), [rows, source])
  const shown = useMemo(() => {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean)
    return mine.filter((row) => {
      if (status !== 'all' && row.status !== status) return false
      const searched = `${row.title} ${row.journal} ${row.submitted?.name ?? ''} ${row.submitted?.email ?? ''}`.toLowerCase()
      return words.every((word) => searched.includes(word))
    })
  }, [mine, status, text])
  const drafts = mine.filter((row) => row.status === 'draft').length
  const picked = chosen.filter((id) => shown.some((row) => row.id === id))
  const allShown = shown.length > 0 && picked.length === shown.length

  const after = (words: string) => {
    setBusy(false)
    setNote(words)
    setChosen([])
    setDeleting(null)
    void load()
    onChanged()
  }
  const change = (ids: string[], to: 'draft' | 'published') => {
    setBusy(true)
    setNote(null)
    setCardStatus(ids, to).then(({ changed }) => after(
      to === 'published'
        ? `${changed} card${changed === 1 ? '' : 's'} published: visitors see ${changed === 1 ? 'it' : 'them'} now.`
        : `${changed} card${changed === 1 ? ' is a draft' : 's are drafts'} now: hidden from visitors.`), failed)
  }
  const remove = (ids: string[]) => {
    setBusy(true)
    removeCards(ids).then(({ removed }) => after(`${removed} card${removed === 1 ? '' : 's'} deleted.`), failed)
  }
  const toggle = (id: string) => setChosen((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))

  if (failure) return <p className="banner bad" role="alert">{failure}</p>
  if (!rows) return <p className="muted">Loading…</p>

  return (
    <div className="admin cards-desk">
      <section className="panel">
        <h2>{source === 'file' ? 'Cards' : 'Submissions'}</h2>
        {source === 'file' ? (
          <p>
            The new cards you added from a file. A <strong>published</strong> card is in the library for everyone; a <strong>draft</strong> is
            hidden from visitors and only you see it, here and in Browse. The cards read from atlas.rsna.org are not listed: they are public
            there, so they are always published.
          </p>
        ) : (
          <p>
            Cards that people sent from the Creator page. Each arrives as a <strong>draft</strong>, checked against the ATLAS schema and
            hidden from visitors. Open a card to read it, then publish it or delete it. You can also ask its author to review it first, under
            Author review.
          </p>
        )}
        <p className="review-counts">
          <strong>{mine.length}</strong> card{mine.length === 1 ? '' : 's'} · <strong>{mine.length - drafts}</strong> published ·{' '}
          <strong>{drafts}</strong> draft{drafts === 1 ? '' : 's'}
        </p>
      </section>

      {source === 'file' && <NewCards count={mine.length} onChanged={() => (void load(), onChanged())} onFailed={failed} />}
      {note && <p className="banner ok" role="status">{note}</p>}

      {mine.length === 0 ? (
        <p className="muted">{source === 'file' ? 'No cards have been added from a file yet.' : 'Nobody has sent a card yet. A card sent from the Creator page appears here.'}</p>
      ) : (
        <>
          <div className="admin-tools">
            <input type="search" value={text} onChange={(event) => setText(event.target.value)}
              placeholder={source === 'file' ? 'Search names and journals' : 'Search names and senders'} aria-label="Search these cards" />
            <div className="segmented small" role="group" aria-label="Status">
              {([['all', `All (${mine.length})`], ['published', `Published (${mine.length - drafts})`], ['draft', `Drafts (${drafts})`]] as [StatusFilter, string][]).map(([key, label]) => (
                <button type="button" key={key} className={status === key ? 'selected' : ''} aria-pressed={status === key} onClick={() => setStatus(key)}>{label}</button>
              ))}
            </div>
          </div>

          <div className="bulk-bar" role="group" aria-label="The ticked cards">
            <span className="muted">{picked.length ? `${picked.length} ticked` : 'Tick cards to change several at once'}</span>
            <button type="button" className="primary" disabled={busy || !picked.length} onClick={() => change(picked, 'published')}>Publish</button>
            <button type="button" disabled={busy || !picked.length} onClick={() => change(picked, 'draft')}>Make draft</button>
            <button type="button" disabled={busy || !picked.length} onClick={() => setDeleting(picked)}>Delete…</button>
          </div>
          {deleting && (
            <div className="panel confirm" role="alertdialog" aria-label="Delete cards">
              <p>
                Delete {deleting.length} card{deleting.length === 1 ? '' : 's'} for good? {deleting.length === 1 ? 'It is' : 'They are'} removed
                from this site, with any author review. This cannot be undone.
              </p>
              <div className="row">
                <button type="button" disabled={busy} onClick={() => remove(deleting)}>Yes, delete</button>
                <button type="button" className="link" disabled={busy} onClick={() => setDeleting(null)}>Keep</button>
              </div>
            </div>
          )}

          <p className="muted" role="status">{shown.length === mine.length ? `${mine.length} cards` : `${shown.length} of ${mine.length} cards`}</p>
          <div className="table-wrap">
            <table className="lib-table admin-table cards-table">
              <thead>
                <tr>
                  <th className="check-cell">
                    <input type="checkbox" checked={allShown} aria-label="Tick every card shown"
                      onChange={() => setChosen(allShown ? [] : shown.map((row) => row.id))} />
                  </th>
                  <th>Name</th>
                  <th>{source === 'file' ? 'Paper' : 'Sent by'}</th>
                  <th>Author review</th>
                  <th>Status</th>
                  <th aria-label="Change" />
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td className="check-cell">
                      <input type="checkbox" checked={chosen.includes(row.id)} onChange={() => toggle(row.id)} aria-label={`Tick ${row.title}`} />
                    </td>
                    <td className="name-cell">
                      <a href={`#/library/${row.id}`}>{row.title}</a>
                      <span className="line"><TypeBadge type={row.type} /></span>
                    </td>
                    <td>
                      {source === 'file'
                        ? [row.journal, row.year].filter(Boolean).join(', ') || '–'
                        : (
                          <>
                            {row.submitted?.name || <span className="muted">No name given</span>}
                            {row.submitted?.email && <span className="muted line">{row.submitted.email}</span>}
                            <span className="muted line">{day(row.submitted?.at)}</span>
                          </>
                        )}
                    </td>
                    <td>{STAGE_WORDS[row.review] ?? <span className="muted">Not asked</span>}</td>
                    <td>
                      <span className={`status-pill ${row.status}`}>{row.status === 'draft' ? 'Draft' : 'Published'}</span>
                    </td>
                    <td className="quick-cell">
                      <button type="button" disabled={busy} onClick={() => change([row.id], row.status === 'draft' ? 'published' : 'draft')}>
                        {row.status === 'draft' ? 'Publish' : 'Make draft'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

/** Cards that are not on ATLAS, added from one file (for example the cards drafted from papers). */
function NewCards({ count, onChanged, onFailed }: { count: number; onChanged: () => void; onFailed: (error: Error) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [removing, setRemoving] = useState(false)
  const failed = (error: Error) => {
    setBusy(false)
    if (error instanceof SignedOut) onFailed(error)
    else setNote({ tone: 'bad', text: error.message })
  }
  const picked = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy(true)
    setNote(null)
    file.text().then(readNewCards).then(addNewCards).then((counts) => {
      setBusy(false)
      setNote({ tone: 'ok', text: `${counts.added} card${counts.added === 1 ? '' : 's'} added${counts.replaced ? `, ${counts.replaced} replaced` : ''}. The library now holds ${counts.total} new cards.` })
      onChanged()
    }, failed)
  }
  const remove = () => {
    setBusy(true)
    removeNewCards().then((result) => {
      setBusy(false)
      setRemoving(false)
      setNote({ tone: 'ok', text: `${result.removed} new card${result.removed === 1 ? '' : 's'} removed.` })
      onChanged()
    }, failed)
  }
  return (
    <section className="panel new-cards">
      <h2>New cards</h2>
      <p>
        Cards that are not on ATLAS, such as the ones drafted from published papers. They are listed in Browse with ATLAS's cards and always
        carry <span className="new-badge"><span aria-hidden="true">✦</span> New</span>, with the paper they came from.{' '}
        <strong>{count}</strong> {count === 1 ? 'is' : 'are'} in the library now.
      </p>
      <input ref={input} type="file" accept="application/json,.json" hidden onChange={picked} />
      <div className="row">
        <button type="button" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Working…' : 'Add cards from a file…'}</button>
        {count > 0 && !removing && <button type="button" className="link" onClick={() => setRemoving(true)}>Remove all new cards</button>}
        {removing && (
          <>
            <button type="button" disabled={busy} onClick={remove}>Yes, remove all {count}</button>
            <button type="button" className="link" disabled={busy} onClick={() => setRemoving(false)}>Keep them</button>
          </>
        )}
      </div>
      {note && <p className={`banner ${note.tone}`} role="status">{note.text}</p>}
      <p className="muted fine">The file is <code>new-cards.json</code>, made by <code>bundle.py</code> in the harvest folder.</p>
    </section>
  )
}
