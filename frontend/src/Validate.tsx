// The page behind a personal link: the card's contact person says whether the card is correct.
// No account is needed; the link itself is the key.
//
// Two ways to answer. The quick one is a single button. The careful one opens the card in the
// card creator (a separate site, in a frame), where every section carries a tick and anything
// wrong can be corrected on the spot; the work is kept on the server as they go, and "Mark as
// reviewed" at the end sends it to the administrator. Without a card creator the page falls
// back to reading the card and writing what should change.

import { useCallback, useEffect, useRef, useState } from 'react'
import { CardBody } from './CardView.tsx'
import { askToFinish, listenToCreator, openInCreator } from './host.ts'
import type { CheckProgress, CheckResult } from './host.ts'
import { day } from './library.ts'
import { getValidation, saveDraft, sendAnswer } from './review.ts'
import type { Answer, Difference, Validation } from './review.ts'

interface ValidateProps {
  token: string
  /** The card creator, when this site has one. */
  creator: { url: string; origin: string } | null
  /** The section-by-section check needs the whole width of the window. */
  onWide: (wide: boolean) => void
}

const FINISH_WAIT_MS = 30_000

export default function Validate({ token, creator, onWide }: ValidateProps) {
  const [page, setPage] = useState<Validation | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [checking, setChecking] = useState(false) // the section-by-section check is open
  const [name, setName] = useState('')
  const [comment, setComment] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [justAnswered, setJustAnswered] = useState(false)

  useEffect(() => {
    let current = true
    getValidation(token).then(
      (found) => {
        if (!current) return
        setPage(found)
        setName(found.name)
        setComment(found.comment)
      },
      (error: Error) => current && setFailure(error.message),
    )
    return () => {
      current = false
    }
  }, [token])

  useEffect(() => {
    onWide(checking)
    return () => onWide(false)
  }, [checking, onWide])

  const answered = useCallback((saved: Validation) => {
    setPage(saved)
    setJustAnswered(true)
    setChecking(false)
    setBusy(false)
    window.scrollTo(0, 0)
  }, [])

  const send = (answer: Answer) => {
    setBusy(true)
    setProblem(null)
    sendAnswer(token, answer).then(answered, (error: Error) => {
      setProblem(error.message)
      setBusy(false)
    })
  }

  if (failure)
    return (
      <section className="panel">
        <h2>This link cannot be used</h2>
        <p>{failure}</p>
        <p className="muted">If you were asked to check a card, reply to the email you received and ask for a new link.</p>
      </section>
    )
  if (!page) return <p className="muted">Loading the card…</p>

  const kind = 'Dataset' in page.record.card ? 'dataset' : 'model'
  const done = page.status === 'approved'
  const hasAnswered = page.status === 'confirmed' || page.status === 'changes' || page.status === 'edited'
  const started = page.draft !== null && page.draft.differences.length + page.draft.flagged.length > 0
  const said =
    page.status === 'confirmed' ? 'You said the card is correct.'
      : page.status === 'edited' ? 'You sent a corrected card.'
        : 'You said the card needs changes.'
  // After answering with corrections, the card below is their own version.
  const shown = !done && page.draft && page.draft.differences.length > 0 ? { ...page.record, card: page.draft.card, facts: null } : page.record

  return (
    <div className="validate">
      <section className="panel">
        <h2>Is this card correct?</h2>
        {done ? (
          <p className="banner ok">Thank you. This card has been marked as author-reviewed; there is nothing more to do.</p>
        ) : (
          <>
            <p>
              This card describes a {kind} and names you as its contact. Please tell us whether it is correct. It takes a few minutes and you
              do not need an account.
            </p>
            {hasAnswered && (
              <p className={`banner ${justAnswered ? 'ok' : 'warn'}`}>
                {justAnswered ? 'Thank you, your answer was received. ' : `You answered on ${day(page.answered_at)}. `}
                {said} An ATLAS administrator will read it; the card is marked as author-reviewed only after their final OK. You can still
                change your answer.
              </p>
            )}
            {!checking && (
              <>
                <div className="row choices">
                  <button type="button" className={hasAnswered || started ? '' : 'primary'} disabled={busy}
                    onClick={() => send({ correct: true, name, comment: '', how: 'quick' })}>
                    I have read the card and it is correct
                  </button>
                  {creator && (
                    <button type="button" className={started && !hasAnswered ? 'primary' : ''} disabled={busy} onClick={() => (setProblem(null), setChecking(true))}>
                      {started ? 'Continue checking and correcting it' : 'Check and correct it section by section'}
                    </button>
                  )}
                </div>
                <p className="muted">
                  {creator
                    ? 'The first button is all it takes if everything below is right. The second lets you go through the card and correct anything that is wrong yourself.'
                    : 'If something is wrong, write what should change at the end of this page.'}
                  {started && page.draft?.saved_at && ` Your corrections so far were saved on ${day(page.draft.saved_at)}.`}
                </p>
                {creator && problem && <p className="banner bad" role="alert">{problem}</p>}
              </>
            )}
            {page.until && <p className="muted">You can come back to this link until {day(page.until)}.</p>}
          </>
        )}
      </section>

      {checking && creator && !done ? (
        <Check page={page} token={token} creator={creator} name={name} comment={comment} onName={setName} onComment={setComment}
          onAnswered={answered} onClose={() => setChecking(false)} onDraft={(draft) => setPage((now) => (now ? { ...now, draft } : now))} />
      ) : (
        <>
          {shown !== page.record && <p className="banner warn">The card below includes your corrections. They are not published until an administrator approves them.</p>}
          <CardBody record={shown} onEdit={null} onRemoveDraft={() => undefined} backTo="" backLabel="" bare />
        </>
      )}

      {!done && !checking && !creator && (
        <section className="panel answer">
          <h2>Your answer</h2>
          <label>
            Your name <span className="muted">(optional)</span>
            <input type="text" value={name} maxLength={200} autoComplete="name" onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Corrections or comments <span className="muted">(needed if the card is not correct)</span>
            <textarea rows={5} value={comment} maxLength={4000} onChange={(event) => setComment(event.target.value)}
              placeholder="For example: the licence is CC BY-NC 4.0, not CC BY 4.0; the test set had 412 patients." />
          </label>
          {problem && <p className="banner bad" role="alert">{problem}</p>}
          <div className="row">
            <button type="button" className="primary" disabled={busy} onClick={() => send({ correct: true, name, comment })}>The card is correct</button>
            <button type="button" disabled={busy}
              onClick={() => (comment.trim() ? send({ correct: false, name, comment }) : setProblem('Please write what needs to change, so the card can be corrected.'))}>
              The card needs changes
            </button>
          </div>
        </section>
      )}
    </div>
  )
}

interface CheckProps {
  page: Validation
  token: string
  creator: { url: string; origin: string }
  name: string
  comment: string
  onName: (name: string) => void
  onComment: (comment: string) => void
  onAnswered: (saved: Validation) => void
  onClose: () => void
  onDraft: (draft: Validation['draft']) => void
}

/** The card in the card creator, section by section, and the final button under it. */
function Check({ page, token, creator, name, comment, onName, onComment, onAnswered, onClose, onDraft }: CheckProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [connected, setConnected] = useState(false)
  const [progress, setProgress] = useState<CheckProgress | null>(null)
  const [differences, setDifferences] = useState<Difference[]>(page.draft?.differences ?? [])
  const [saved, setSaved] = useState<'saved' | 'saving' | 'failed' | null>(page.draft ? 'saved' : null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // What the creator is given when it is ready: read once, so a later re-render never reopens the card over the author's work.
  const [opening] = useState(() => ({ card: page.draft?.card ?? page.record.card, original: page.record.card, flagged: page.draft?.flagged ?? page.flagged }))
  const lastSaved = useRef(page.draft ? JSON.stringify([page.draft.card, page.draft.flagged]) : '')
  const waiting = useRef<{ id: string; timer: number } | null>(null)
  const answer = useRef({ name, comment })
  useEffect(() => {
    answer.current = { name, comment }
  })
  const title = page.record.facts?.title || page.record.title || 'card'
  const cardType = 'Dataset' in page.record.card ? 'dataset' : 'model'

  /** The creator's verdict on the final button: send the answer, or say what stands in the way. */
  const finished = useCallback((result: CheckResult) => {
    if (!waiting.current || result.id !== waiting.current.id) return
    window.clearTimeout(waiting.current.timer)
    waiting.current = null
    if (!result.ok) {
      setProblem(result.reason || 'The card could not be checked. Try again.')
      setBusy(false)
      return
    }
    sendAnswer(token, { correct: result.flagged.length === 0, name: answer.current.name, comment: answer.current.comment, how: 'sections', card: result.card, flagged: result.flagged })
      .then(onAnswered, (error: Error) => {
        setProblem(error.message)
        setBusy(false)
      })
  }, [token, onAnswered])

  useEffect(
    () => listenToCreator(() => frame.current?.contentWindow ?? null, creator.origin, {
      onReady: () => {
        if (!frame.current?.contentWindow) return
        openInCreator(frame.current.contentWindow, creator.origin, { cardType, title, card: opening.card, check: { original: opening.original, flagged: opening.flagged } })
        setConnected(true)
      },
      onProgress: setProgress,
      onResult: finished,
    }),
    [creator.origin, cardType, title, finished, opening],
  )

  // Keep the author's version on the server a moment after every change. Opening the card without touching it keeps nothing.
  useEffect(() => {
    if (!progress) return
    const now = JSON.stringify([progress.card, progress.flagged])
    const untouched = progress.changed.length === 0 && progress.flagged.length === 0
    if (now === lastSaved.current || (untouched && lastSaved.current === '')) return
    const timer = window.setTimeout(() => {
      setSaved('saving')
      saveDraft(token, progress.card, progress.flagged).then(
        (draft) => {
          lastSaved.current = now
          setDifferences(draft.differences)
          setSaved('saved')
          onDraft(draft)
        },
        () => setSaved('failed'),
      )
    }, 700)
    return () => window.clearTimeout(timer)
  }, [progress, token, onDraft])

  const flagged = progress?.flagged ?? opening.flagged
  const problems = progress?.problems ?? 0
  const untouched = differences.length === 0 && flagged.length === 0

  const finish = () => {
    if (flagged.length && !comment.trim()) {
      setProblem(`You marked ${flagged.join(', ')} as not right. Please write what is wrong there, so the card can be corrected.`)
      return
    }
    if (!frame.current?.contentWindow) return
    setBusy(true)
    setProblem(null)
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const timer = window.setTimeout(() => {
      waiting.current = null
      setBusy(false)
      setProblem('The card creator did not answer. Check your connection and try again; your corrections are saved.')
    }, FINISH_WAIT_MS)
    waiting.current = { id, timer }
    askToFinish(frame.current.contentWindow, creator.origin, id)
  }

  return (
    <>
      <p className="muted check-intro">
        Every section starts ticked as right. Go through them on the left; if something is wrong, correct it in place, or untick the section
        and say what is wrong at the end. <button type="button" className="link" onClick={onClose}>Back to reading the card</button>
      </p>
      <iframe ref={frame} className="creator-frame check-frame" src={`${creator.url}/?check=1`} title="Your card, section by section"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
      {!connected && <p className="muted fine">Opening your card…</p>}

      <section className="panel answer">
        <h2>Finish your review</h2>
        {untouched ? (
          <p>You have not changed anything. Marking the card as reviewed says that it is correct as it is.</p>
        ) : (
          <>
            {differences.length > 0 && (
              <>
                <p><strong>Your corrections ({differences.length})</strong></p>
                <Differences rows={differences} />
              </>
            )}
            {flagged.length > 0 && <p><strong>Marked as not right:</strong> {flagged.join(', ')}. Please say below what is wrong there.</p>}
          </>
        )}
        {problems > 0 && (
          <p className="banner warn">
            {problems} thing{problems === 1 ? '' : 's'} in the card {problems === 1 ? 'does' : 'do'} not fit the ATLAS format yet. {problems === 1 ? 'It is' : 'They are'} listed
            above the card, under “What to fix”.
          </p>
        )}
        <label>
          Your name <span className="muted">(optional)</span>
          <input type="text" value={name} maxLength={200} autoComplete="name" onChange={(event) => onName(event.target.value)} />
        </label>
        <label>
          Comments <span className="muted">({flagged.length ? 'needed: what is wrong in the sections you unticked' : 'optional'})</span>
          <textarea rows={4} value={comment} maxLength={4000} onChange={(event) => onComment(event.target.value)}
            placeholder="Anything the administrator should know." />
        </label>
        {problem && <p className="banner bad" role="alert">{problem}</p>}
        <div className="row">
          <button type="button" className="primary" disabled={busy || !connected || problems > 0} onClick={finish}>
            {busy ? 'Checking the card…' : 'Mark as reviewed'}
          </button>
          <span className="muted" role="status">
            {saved === 'saving' ? 'Saving…'
              : saved === 'failed' ? 'Your last change could not be saved. Check your connection.'
                : saved === 'saved' ? 'Your work is saved. You can close this page and come back with the same link.'
                  : ''}
          </span>
        </div>
        <p className="muted fine">Nothing is published until an ATLAS administrator has read your review and given the final OK.</p>
      </section>
    </>
  )
}

/** What changed, fact by fact: where, what it was, what it is now. */
export function Differences({ rows }: { rows: Difference[] }) {
  return (
    <ul className="differences">
      {rows.map((row) => (
        <li key={row.where}>
          <span className="where">{row.where}</span>
          <span className="change">
            {row.before ? <del>{row.before}</del> : <span className="muted">(empty)</span>}
            <span aria-hidden="true"> → </span>
            {row.after ? <ins>{row.after}</ins> : <span className="muted">(removed)</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}
