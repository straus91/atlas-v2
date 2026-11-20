// The admin view: where each card's author review stands, and the steps only an administrator
// takes. With validation emails switched on, the contacts of chosen cards are asked to check
// their card through a personal link; the card shows "Author-reviewed" once the contact has
// said it is correct and the administrator has given the final OK.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { ReviewedBadge, TypeBadge } from './Library.tsx'
import { day } from './library.ts'
import {
  STAGES, SignedOut, addressFor, approve, ask, canAsk, clearReview, getReviews, getSession, isAddress, markByHand, nameFor, saveSettings, signIn, signOut, stageOf,
} from './review.ts'
import type { AdminData, AdminRow, ReviewSettings, Session, Stage } from './review.ts'

export default function Admin({ onMarksChanged }: { onMarksChanged: () => void }) {
  const [session, setSession] = useState<Session | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    getSession().then(setSession, (error: Error) => setFailure(error.message))
  }, [])

  if (failure) return <p className="banner bad">{failure}</p>
  if (!session) return <p className="muted">Loading…</p>
  if (!session.configured)
    return (
      <section className="panel">
        <h2>Admin</h2>
        <p>
          The admin view is switched off on this site. To switch it on, add a line <code>ADMIN_PASSWORD=…</code> with a password of your
          choice to the site's settings file (<code>.env</code>) and restart the site.
        </p>
      </section>
    )
  if (!session.signed_in) return <SignIn onSignedIn={setSession} />
  return <Desk onSignedOut={() => setSession({ configured: true, signed_in: false })} onMarksChanged={onMarksChanged} />
}

function SignIn({ onSignedIn }: { onSignedIn: (session: Session) => void }) {
  const [password, setPassword] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setProblem(null)
    signIn(password).then(onSignedIn, (error: Error) => {
      setProblem(error.message)
      setBusy(false)
    })
  }
  return (
    <form className="panel sign-in" onSubmit={submit}>
      <h2>Admin</h2>
      <label>
        Password
        <input type="password" value={password} autoComplete="current-password" autoFocus onChange={(event) => setPassword(event.target.value)} />
      </label>
      {problem && <p className="banner bad" role="alert">{problem}</p>}
      <button type="submit" className="primary" disabled={busy || !password}>Sign in</button>
    </form>
  )
}

type StageFilter = Stage | 'all'

function Desk({ onSignedOut, onMarksChanged }: { onSignedOut: () => void; onMarksChanged: () => void }) {
  const [data, setData] = useState<AdminData | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [typed, setTyped] = useState<Record<string, string>>({}) // addresses the administrator typed, by card
  const [chosen, setChosen] = useState<string[]>([])
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  const [outcome, setOutcome] = useState<{ good: string; problems: string[] } | null>(null)
  const [stage, setStage] = useState<StageFilter>('all')
  const [withContact, setWithContact] = useState(false)
  const [text, setText] = useState('')

  const failed = useCallback((error: Error) => (error instanceof SignedOut ? onSignedOut() : setFailure(error.message)), [onSignedOut])
  const load = useCallback(() => getReviews().then((found) => (setData(found), setFailure(null)), failed), [failed])
  useEffect(() => void load(), [load])
  /** After a step that can change which cards carry the mark. */
  const changed = useCallback(() => {
    void load()
    onMarksChanged()
  }, [load, onMarksChanged])

  const rows = data?.cards
  const emails = data?.settings.emails_enabled ?? false
  const counts = useMemo(() => {
    const totals = new Map<Stage, number>()
    for (const row of rows ?? []) totals.set(stageOf(row.review), (totals.get(stageOf(row.review)) ?? 0) + 1)
    return totals
  }, [rows])
  const shown = useMemo(() => {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean)
    return (rows ?? []).filter((row) => {
      if (stage !== 'all' && stageOf(row.review) !== stage) return false
      if (withContact && !row.contacts.length && !row.review?.email) return false
      const searched = `${row.title} ${row.contacts.map((contact) => `${contact.email} ${contact.name}`).join(' ')} ${row.review?.email ?? ''}`.toLowerCase()
      return words.every((word) => searched.includes(word))
    })
  }, [rows, stage, withContact, text])

  if (failure && !data) return <p className="banner bad">{failure}</p>
  if (!data || !rows) return <p className="muted">Loading the reviews…</p>

  const askable = (row: AdminRow) => emails && canAsk(stageOf(row.review)) && isAddress(addressFor(row, typed[row.id]))
  const toAsk = rows.filter((row) => chosen.includes(row.id) && askable(row))
  const shownAskable = shown.filter(askable)
  const allChosen = shownAskable.length > 0 && shownAskable.every((row) => chosen.includes(row.id))
  const choose = (id: string, on: boolean) => setChosen((current) => (on ? [...new Set([...current, id])] : current.filter((item) => item !== id)))
  const chooseShown = (on: boolean) => {
    const ids = shownAskable.map((row) => row.id)
    setChosen((current) => (on ? [...new Set([...current, ...ids])] : current.filter((id) => !ids.includes(id))))
  }

  const switchEmails = (on: boolean) =>
    saveSettings({ emails_enabled: on }).then((settings) => {
      setData({ ...data, settings })
      if (!on) setChosen([])
    }, failed)

  const send = () => {
    setSending(true)
    const titles = new Map(toAsk.map((row) => [row.id, row.title]))
    ask(toAsk.map((row) => ({ id: row.id, email: addressFor(row, typed[row.id]), name: nameFor(row, addressFor(row, typed[row.id])) }))).then(
      (results) => {
        const sent = results.filter((result) => result.ok && result.sent).length
        const links = results.filter((result) => result.ok && !result.sent)
        const parts = []
        if (sent) parts.push(`${sent} email${sent === 1 ? '' : 's'} sent.`)
        if (links.length) parts.push(`${links.length} personal link${links.length === 1 ? '' : 's'} made, but no email was sent (${links[0].problem}). Copy each link from the list and send it yourself.`)
        setOutcome({ good: parts.join(' '), problems: results.filter((result) => !result.ok).map((result) => `${titles.get(result.id) ?? result.id}: ${result.problem}`) })
        setChosen([])
        setTyped({})
        setConfirming(false)
        setSending(false)
        void load()
      },
      (error: Error) => {
        setSending(false)
        failed(error)
      },
    )
  }

  const total = (wanted: Stage) => counts.get(wanted) ?? 0

  return (
    <div className="admin">
      <section className="panel">
        <div className="row spread">
          <h2>Author review</h2>
          <button type="button" className="link" onClick={() => signOut().then(onSignedOut, onSignedOut)}>Sign out</button>
        </div>
        <p>
          A card shows <span className="reviewed-badge"><span aria-hidden="true">✓</span> Author-reviewed</span> when its contact person has said that the card is correct
          and you have given the final OK. If the card changes afterwards, the mark is hidden until the card is reviewed again.
        </p>
        <p className="review-counts">
          <strong>{total('approved')}</strong> author-reviewed · <strong>{total('confirmed')}</strong> waiting for your final OK ·{' '}
          <strong>{total('requested')}</strong> waiting for the contact · <strong>{total('changes')}</strong> with changes asked
          {total('stale') > 0 && <> · <strong>{total('stale')}</strong> changed since their review</>}
        </p>
        <label className="check">
          <input type="checkbox" checked={emails} onChange={(event) => void switchEmails(event.target.checked)} />
          <span>
            <strong>Validation emails</strong>
            <span className="muted block">Lets you tick cards in the list and ask their contact persons to check them.</span>
          </span>
        </label>
        {emails && (
          <>
            <p className={`banner ${data.mail.configured ? 'ok' : 'warn'}`}>
              {data.mail.configured
                ? `Emails are sent from ${data.mail.sender}. Each one carries a personal link that works for ${data.link_days} days.`
                : `No mail server is set up on this site, so no email is sent. A personal link is still made for each card you ask about (it works for ${data.link_days} days): copy it from the list and send it yourself.`}
            </p>
            <MessageEditor settings={data.settings} onSaved={(settings) => setData({ ...data, settings })} onFailed={failed} />
          </>
        )}
      </section>

      {failure && <p className="banner bad" role="alert">{failure}</p>}
      {outcome && (
        <div className={`banner ${outcome.problems.length ? 'warn' : 'ok'}`} role="status">
          {outcome.good && <p>{outcome.good}</p>}
          {outcome.problems.length > 0 && (
            <>
              <p>Not asked:</p>
              <ul>{outcome.problems.map((line) => <li key={line}>{line}</li>)}</ul>
            </>
          )}
          <button type="button" className="link" onClick={() => setOutcome(null)}>Close</button>
        </div>
      )}

      <div className="admin-bar">
        <input type="search" value={text} onChange={(event) => setText(event.target.value)} placeholder="Search cards and addresses" aria-label="Search cards and addresses" />
        <label className="muted inline">
          Show{' '}
          <select value={stage} onChange={(event) => setStage(event.target.value as StageFilter)}>
            <option value="all">All cards ({rows.length})</option>
            {STAGES.filter((item) => total(item.stage) > 0 || item.stage === stage).map((item) => (
              <option key={item.stage} value={item.stage}>{item.label} ({total(item.stage)})</option>
            ))}
          </select>
        </label>
        <label className="check small">
          <input type="checkbox" checked={withContact} onChange={(event) => setWithContact(event.target.checked)} />
          <span>Only cards that give a contact address</span>
        </label>
        {emails && (
          <span className="row ask-row">
            <span className="muted">{toAsk.length ? `${toAsk.length} chosen` : 'Tick cards to ask their contacts'}</span>
            <button type="button" className="primary" disabled={!toAsk.length || confirming} onClick={() => setConfirming(true)}>
              Ask {toAsk.length || ''} contact{toAsk.length === 1 ? '' : 's'}…
            </button>
          </span>
        )}
      </div>

      {confirming && toAsk.length > 0 && (
        <section className="panel confirm-send">
          <h2>{data.mail.configured ? `Send ${toAsk.length} email${toAsk.length === 1 ? '' : 's'}?` : `Make ${toAsk.length} personal link${toAsk.length === 1 ? '' : 's'}?`}</h2>
          <p className="muted">
            {data.mail.configured
              ? `Each person below gets the message from ${data.mail.sender} with a link to their card.`
              : 'No mail server is set up, so nothing is sent. You get a link for each card to send yourself.'}{' '}
            A link sent earlier for the same card stops working.
          </p>
          <ul className="recipients">
            {toAsk.map((row) => (
              <li key={row.id}>
                <strong>{addressFor(row, typed[row.id])}</strong> <span className="muted">for</span> {row.title}
              </li>
            ))}
          </ul>
          <div className="row">
            <button type="button" className="primary" disabled={sending} onClick={send}>
              {sending ? 'Working…' : data.mail.configured ? 'Send now' : 'Make the links'}
            </button>
            <button type="button" disabled={sending} onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </section>
      )}

      <p className="muted" role="status">{shown.length === rows.length ? `${rows.length} cards` : `${shown.length} of ${rows.length} cards`}</p>
      <div className="table-wrap lib-table-wrap">
        <table className="lib-table admin-table">
          <thead>
            <tr>
              {emails && (
                <th>
                  <input type="checkbox" checked={allChosen} disabled={!shownAskable.length} onChange={(event) => chooseShown(event.target.checked)}
                    aria-label="Choose every card shown whose contact can be asked" title="Choose every card shown whose contact can be asked" />
                </th>
              )}
              <th>Card</th>
              <th>Contact</th>
              <th>Review</th>
              <th>Steps</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <Row key={row.id} row={row} emails={emails} address={addressFor(row, typed[row.id])} askable={askable(row)}
                checked={chosen.includes(row.id)} onCheck={(on) => choose(row.id, on)}
                onType={(value) => setTyped((current) => ({ ...current, [row.id]: value }))} onChanged={changed} onFailed={failed} />
            ))}
          </tbody>
        </table>
      </div>
      {shown.length === 0 && <p className="panel muted">No card matches.</p>}
    </div>
  )
}

interface MessageEditorProps {
  settings: ReviewSettings
  onSaved: (settings: ReviewSettings) => void
  onFailed: (error: Error) => void
}

function MessageEditor({ settings, onSaved, onFailed }: MessageEditorProps) {
  const [subject, setSubject] = useState(settings.subject)
  const [body, setBody] = useState(settings.body)
  const [note, setNote] = useState<string | null>(null)
  const unsaved = subject !== settings.subject || body !== settings.body
  const standard = subject === settings.standard_subject && body === settings.standard_body
  const save = () => {
    if (!body.includes('{link}')) {
      setNote('The message must contain {link}, the place where the personal link goes.')
      return
    }
    saveSettings({ subject, body }).then((saved) => {
      onSaved(saved)
      setNote('Saved.')
    }, onFailed)
  }
  return (
    <details className="message-editor">
      <summary>The message the contact receives</summary>
      <label>
        Subject
        <input type="text" value={subject} maxLength={200} onChange={(event) => (setSubject(event.target.value), setNote(null))} />
      </label>
      <label>
        Text
        <textarea rows={14} value={body} maxLength={5000} onChange={(event) => (setBody(event.target.value), setNote(null))} />
      </label>
      <p className="help">
        Filled in for each card: <code>{'{name}'}</code> the contact's name (or “colleague”), <code>{'{card}'}</code> the card's name,{' '}
        <code>{'{type}'}</code> model or dataset, <code>{'{link}'}</code> the personal link, <code>{'{until}'}</code> the last day the link works.
      </p>
      {note && <p className={`banner ${note === 'Saved.' ? 'ok' : 'bad'}`} role="status">{note}</p>}
      <div className="row">
        <button type="button" className="primary" disabled={!unsaved} onClick={save}>Save the message</button>
        <button type="button" disabled={standard} onClick={() => (setSubject(settings.standard_subject), setBody(settings.standard_body), setNote(null))}>
          Put back the standard text
        </button>
      </div>
    </details>
  )
}

interface RowProps {
  row: AdminRow
  emails: boolean
  address: string
  askable: boolean
  checked: boolean
  onCheck: (on: boolean) => void
  onType: (value: string) => void
  onChanged: () => void
  onFailed: (error: Error) => void
}

function Row({ row, emails, address, askable, checked, onCheck, onType, onChanged, onFailed }: RowProps) {
  const [marking, setMarking] = useState(false)
  const [note, setNote] = useState('')
  const [removing, setRemoving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const review = row.review
  const stage = stageOf(review)
  const editable = emails && canAsk(stage)
  const source = row.contacts.find((contact) => contact.email.toLowerCase() === address.toLowerCase())

  const run = (step: Promise<unknown>) => {
    setBusy(true)
    setProblem(null)
    step.then(
      () => {
        setBusy(false)
        setMarking(false)
        setRemoving(false)
        setNote('')
        onChanged()
      },
      (error: Error) => {
        setBusy(false)
        if (error instanceof SignedOut) onFailed(error)
        else setProblem(error.message)
      },
    )
  }

  return (
    <tr className={checked ? 'chosen' : ''}>
      {emails && (
        <td className="tick">
          <input type="checkbox" checked={checked && askable} disabled={!askable} onChange={(event) => onCheck(event.target.checked)}
            aria-label={`Ask the contact of ${row.title}`}
            title={askable ? 'Ask this contact to check the card' : canAsk(stage) ? 'Give an email address first' : 'Nothing to ask at this step'} />
        </td>
      )}
      <td className="name-cell">
        <a href={`#/library/${row.id}`}>{row.title}</a>
        <span className="line"><TypeBadge type={row.type} /></span>
      </td>
      <td className="contact-cell">
        {editable ? (
          <>
            <input type="email" value={address} list={`contacts-${row.id}`} placeholder="name@example.org" aria-label={`Contact address for ${row.title}`}
              className={address && !isAddress(address) ? 'invalid' : ''} onChange={(event) => onType(event.target.value)} />
            {row.contacts.length > 1 && (
              <datalist id={`contacts-${row.id}`}>{row.contacts.map((contact) => <option key={contact.email} value={contact.email}>{contact.name}</option>)}</datalist>
            )}
          </>
        ) : address ? <span className="wrap">{address}</span> : <span className="muted">No address in the card</span>}
        {source && <span className="muted line">{[source.name, `from ${source.source}`].filter(Boolean).join(' · ')}</span>}
        {!source && address && editable && <span className="muted line">typed by you</span>}
        {!address && editable && <span className="muted line">The card gives no address. Type one to ask this contact.</span>}
      </td>
      <td className="review-cell"><Standing row={row} stage={stage} /></td>
      <td className="steps-cell">
        {stage === 'confirmed' && (
          <button type="button" className="primary" disabled={busy} onClick={() => run(approve(row.id))}>Give the final OK</button>
        )}
        {stage !== 'approved' && stage !== 'confirmed' && !marking && (
          <button type="button" className="link" onClick={() => setMarking(true)} title="For a card its author wrote, or confirmed to you another way">
            Mark as reviewed by hand
          </button>
        )}
        {marking && (
          <span className="by-hand">
            <input type="text" value={note} maxLength={500} autoFocus placeholder="How do you know? (kept with the mark)" aria-label="How do you know the author reviewed this card?"
              onChange={(event) => setNote(event.target.value)} />
            <span className="row">
              <button type="button" className="primary" disabled={busy || !note.trim()} onClick={() => run(markByHand(row.id, note))}>Mark</button>
              <button type="button" disabled={busy} onClick={() => setMarking(false)}>Cancel</button>
            </span>
          </span>
        )}
        {review && !removing && (
          <button type="button" className="link" onClick={() => setRemoving(true)}>
            {stage === 'approved' ? 'Remove the mark' : stage === 'requested' ? 'Withdraw the request' : 'Forget this review'}
          </button>
        )}
        {removing && (
          <span className="row">
            <button type="button" disabled={busy} onClick={() => run(clearReview(row.id))}>Yes, remove</button>
            <button type="button" className="link" disabled={busy} onClick={() => setRemoving(false)}>Keep</button>
          </span>
        )}
        {problem && <span className="banner bad" role="alert">{problem}</span>}
      </td>
    </tr>
  )
}

/** Where a card's review stands, in words, with what the administrator needs at that step. */
function Standing({ row, stage }: { row: AdminRow; stage: Stage }): ReactNode {
  const review = row.review
  if (!review || stage === 'none') return <span className="muted">Not asked</span>
  const who = [review.answered_by || review.name || review.email, day(review.answered_at)].filter(Boolean).join(', ')
  return (
    <>
      {stage === 'requested' && (
        <>
          <strong>Waiting for the contact</strong>
          <span className="muted line">
            Asked on {day(review.requested_at)}. {review.email_sent ? `Email sent to ${review.email}.` : `No email was sent (${review.email_problem}).`}{' '}
            The link works until {day(review.expires_at)}.
          </span>
          <CopyLine review={review} />
        </>
      )}
      {stage === 'confirmed' && (
        <>
          <strong className="good">The contact says the card is correct</strong>
          <span className="muted line">{who}. Waiting for your final OK.</span>
          {review.comment && <span className="quote">{review.comment}</span>}
        </>
      )}
      {stage === 'changes' && (
        <>
          <strong className="attention">The contact asks for changes</strong>
          <span className="muted line">{who}</span>
          <span className="quote">{review.comment}</span>
          <span className="muted line">Correct the card on ATLAS, then ask the contact again.</span>
        </>
      )}
      {stage === 'approved' && (
        <>
          <ReviewedBadge card={{ author_reviewed: review.approved_at?.slice(0, 10) }} />
          <span className="muted line">
            {review.by_hand ? `Marked by hand on ${day(review.approved_at)}: ${review.note}` : `Confirmed by ${who}; final OK on ${day(review.approved_at)}.`}
          </span>
        </>
      )}
      {stage === 'stale' && (
        <>
          <strong className="attention">The card has changed since its review</strong>
          <span className="muted line">
            {review.status === 'approved' ? 'The mark is hidden.' : 'The contact confirmed an earlier version.'} Ask the contact again, or forget this review.
          </span>
        </>
      )}
      {review.history && review.history.length > 1 && (
        <details className="history">
          <summary>History</summary>
          <ul>{review.history.map((entry) => <li key={entry.at + entry.what}><span className="muted">{day(entry.at)}</span> {entry.what}</li>)}</ul>
        </details>
      )}
    </>
  )
}

/** The personal link, and the whole message, to copy and send by hand. */
function CopyLine({ review }: { review: NonNullable<AdminRow['review']> }) {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (what: string, value: string) =>
    navigator.clipboard.writeText(value).then(() => setCopied(what), () => setCopied('failed'))
  if (!review.link) return null
  return (
    <span className="copy-line">
      {!review.email_sent && <input type="text" readOnly value={review.link} aria-label="Personal link" onFocus={(event) => event.target.select()} />}
      <span className="row">
        <button type="button" className="link" onClick={() => void copy('link', review.link!)}>Copy the link</button>
        {review.body && (
          <button type="button" className="link" onClick={() => void copy('message', `${review.subject ?? ''}\n\n${review.body}`)}>Copy the whole message</button>
        )}
        {copied && <span className="muted" role="status">{copied === 'failed' ? 'Could not copy; select the link instead.' : `Copied the ${copied}.`}</span>}
      </span>
    </span>
  )
}
