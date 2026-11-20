// Author review: what the admin page and the contact person's page ask the server, and the
// small decisions both share. A review goes requested -> confirmed or changes -> approved;
// only an approved review of the card as it is now shows the "Author-reviewed" mark.

import type { LibraryRecord } from './library.ts'

export interface Contact {
  email: string
  name: string
  source: string // where in the card the address was found
}

export interface Review {
  status: 'requested' | 'confirmed' | 'changes' | 'approved'
  email?: string
  name?: string
  link?: string // the personal link, for sending by hand
  requested_at?: string
  expires_at?: string
  email_sent?: boolean
  email_problem?: string
  subject?: string
  body?: string
  answered_at?: string
  answered_by?: string
  comment?: string
  approved_at?: string
  by_hand?: boolean
  note?: string
  history?: { at: string; what: string }[]
  /** The card is no longer the one that was reviewed. */
  changed: boolean
}

export interface AdminRow {
  id: string
  title: string
  type: 'dataset' | 'model'
  contacts: Contact[]
  review: Review | null
}

export interface ReviewSettings {
  emails_enabled: boolean
  subject: string
  body: string
  standard_subject: string
  standard_body: string
}

export interface AdminData {
  cards: AdminRow[]
  settings: ReviewSettings
  link_days: number
  mail: { configured: boolean; sender: string }
}

export interface Session {
  configured: boolean // the site has an admin password
  signed_in: boolean
}

export interface AskResult {
  id: string
  ok: boolean
  sent?: boolean
  problem: string
}

/** What the contact person's page shows. */
export interface Validation {
  record: LibraryRecord
  status: Review['status']
  name: string
  comment: string
  answered_at: string | null
  until: string | null
}

export class SignedOut extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  })
  if (response.ok) return (await response.json()) as T
  let reason = `The server answered with an error (${response.status}).`
  try {
    const detail = ((await response.json()) as { detail?: unknown }).detail
    if (typeof detail === 'string') reason = detail
  } catch {
    // not a message from the site itself: keep the plain reason
  }
  if (response.status === 401 && path !== '/api/admin/login') throw new SignedOut(reason)
  throw new Error(reason)
}

export const getSession = () => call<Session>('GET', '/api/admin/session')
export const signIn = (password: string) => call<Session>('POST', '/api/admin/login', { password })
export const signOut = () => call<Session>('POST', '/api/admin/logout')
export const getReviews = () => call<AdminData>('GET', '/api/admin/reviews')
export const saveSettings = (change: Partial<Pick<ReviewSettings, 'emails_enabled' | 'subject' | 'body'>>) =>
  call<ReviewSettings>('PUT', '/api/admin/settings', change)
export const approve = (id: string) => call<{ review: Review }>('POST', `/api/admin/reviews/${encodeURIComponent(id)}/approve`)
export const markByHand = (id: string, note: string) => call<{ review: Review }>('POST', `/api/admin/reviews/${encodeURIComponent(id)}/mark`, { note })
export const clearReview = (id: string) => call<{ review: null }>('DELETE', `/api/admin/reviews/${encodeURIComponent(id)}`)

const BATCH = 50 // the most the server takes in one request

/** Ask the contacts of these cards, in the order given. */
export async function ask(cards: { id: string; email: string; name: string }[]): Promise<AskResult[]> {
  const results: AskResult[] = []
  for (let start = 0; start < cards.length; start += BATCH) {
    const answer = await call<{ results: AskResult[] }>('POST', '/api/admin/reviews/request', { cards: cards.slice(start, start + BATCH) })
    results.push(...answer.results)
  }
  return results
}

export const getValidation = (token: string) => call<Validation>('GET', `/api/validate/${encodeURIComponent(token)}`)
export const sendAnswer = (token: string, answer: { correct: boolean; name: string; comment: string }) =>
  call<Validation>('POST', `/api/validate/${encodeURIComponent(token)}`, answer)

// ------------------------------------------------------------------ where a review stands
export type Stage = 'none' | 'requested' | 'confirmed' | 'changes' | 'approved' | 'stale'

export const STAGES: { stage: Stage; label: string }[] = [
  { stage: 'none', label: 'Not asked' },
  { stage: 'requested', label: 'Waiting for the contact' },
  { stage: 'confirmed', label: 'Waiting for your final OK' },
  { stage: 'changes', label: 'Contact asks for changes' },
  { stage: 'approved', label: 'Author-reviewed' },
  { stage: 'stale', label: 'Card changed since its review' },
]

/** A confirmed or approved review of an older version of the card counts for nothing until the contact is asked again. */
export function stageOf(review: Review | null): Stage {
  if (!review) return 'none'
  if (review.changed && (review.status === 'approved' || review.status === 'confirmed')) return 'stale'
  return review.status
}

/** Cards whose contact can be asked (again). Not while an answer waits for the final OK, and not once the mark is given. */
export const canAsk = (stage: Stage) => stage !== 'confirmed' && stage !== 'approved'

const ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/
export const isAddress = (text: string) => ADDRESS.test(text.trim())

/** The address to ask: what the administrator typed, else the one asked before, else the card's first contact. */
export function addressFor(row: AdminRow, typed: string | undefined): string {
  return (typed ?? row.review?.email ?? row.contacts[0]?.email ?? '').trim()
}

/** The name that goes with an address, when the card gives one. */
export function nameFor(row: AdminRow, address: string): string {
  const wanted = address.toLowerCase()
  const known = row.contacts.find((contact) => contact.email.toLowerCase() === wanted)?.name
  return known || (row.review?.email?.toLowerCase() === wanted ? (row.review.name ?? '') : '')
}
