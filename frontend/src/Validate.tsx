// The page behind a personal link: the card's contact person reads the card and says whether
// it is correct. No account is needed; the link itself is the key.

import { useEffect, useState } from 'react'
import { CardBody } from './CardView.tsx'
import { day } from './library.ts'
import { getValidation, sendAnswer } from './review.ts'
import type { Validation } from './review.ts'

export default function Validate({ token }: { token: string }) {
  const [page, setPage] = useState<Validation | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
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

  const answer = (correct: boolean) => {
    if (!correct && !comment.trim()) {
      setProblem('Please write what needs to change, so the card can be corrected.')
      return
    }
    setBusy(true)
    setProblem(null)
    sendAnswer(token, { correct, name, comment }).then(
      (saved) => {
        setPage(saved)
        setJustAnswered(true)
        setBusy(false)
        window.scrollTo(0, 0)
      },
      (error: Error) => {
        setProblem(error.message)
        setBusy(false)
      },
    )
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
  const answered = page.status === 'confirmed' || page.status === 'changes'

  return (
    <div className="validate">
      <section className="panel">
        <h2>Is this card correct?</h2>
        {done ? (
          <p className="banner ok">Thank you. This card has been marked as author-reviewed; there is nothing more to do.</p>
        ) : (
          <>
            <p>
              This card describes a {kind} and names you as its contact. Please read it and tell us, at the end of this page, whether it is
              correct or needs changes. It takes a few minutes and you do not need an account.
            </p>
            {page.until && <p className="muted">You can come back to this link until {day(page.until)}.</p>}
            {answered && (
              <p className={`banner ${justAnswered ? 'ok' : 'warn'}`}>
                {justAnswered ? 'Thank you, your answer was received. ' : `You answered on ${day(page.answered_at)}. `}
                {page.status === 'confirmed' ? 'You said the card is correct.' : 'You said the card needs changes.'} An ATLAS administrator
                will read it; the card is marked as author-reviewed only after their final OK. You can still change your answer below.
              </p>
            )}
          </>
        )}
      </section>

      <CardBody record={page.record} onEdit={null} onRemoveDraft={() => undefined} backTo="" backLabel="" bare />

      {!done && (
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
            <button type="button" className="primary" disabled={busy} onClick={() => answer(true)}>The card is correct</button>
            <button type="button" disabled={busy} onClick={() => answer(false)}>The card needs changes</button>
          </div>
        </section>
      )}
    </div>
  )
}
