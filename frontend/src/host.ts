// The host's half of the hand-over with the card creator.
//
// The card creator is a separate site, shown in a frame on the Creator page. The two talk with
// window.postMessage, in plain JSON, and only with each other's exact address:
//
//   creator -> host   { source: 'roadmap-card-creator', type: 'ready', version: 1 }
//   creator -> host   { source: 'roadmap-card-creator', type: 'card', version: 1, id,
//                       cardType: 'dataset' | 'model', description, fileName, card }
//   host -> creator   { source: 'atlas', type: 'card-received', id }
//   host -> creator   { source: 'atlas', type: 'card-rejected', id, reason }
//   host -> creator   { source: 'atlas', type: 'open-card', version: 1, cardType, title, card }
//
// Author check (the page behind a contact person's link): the card is opened with a `check`
// part, and the creator then shows, instead of its own buttons, whether each section is right
// as it is or was edited by the author.
//
//   host -> creator   { ...open-card, check: { original } }
//   creator -> host   { source: 'roadmap-card-creator', type: 'check-progress', version: 1,
//                       cardType, card, changed, problems }               (a moment after every change)
//   host -> creator   { source: 'atlas', type: 'check-finish', id }       (the final button was pressed)
//   creator -> host   { source: 'roadmap-card-creator', type: 'check-result', version: 1, id,
//                       ok, reason?, cardType, card, changed }            (ok: the card fits the schema)
//
// The real ATLAS would implement this same half (see the card creator's docs/send-to-atlas.md).

export interface ReceivedCard {
  cardType: 'dataset' | 'model'
  description: string
  fileName: string
  card: Record<string, unknown>
}

export interface CardToOpen {
  cardType: 'dataset' | 'model'
  title: string
  card: Record<string, unknown>
  /** Open the card for an author check: `original` is the published card, to tell which sections the author edited. */
  check?: { original: Record<string, unknown> }
}

/** How far the author is, as the creator reports it. Sections are named as the creator shows them. */
export interface CheckProgress {
  card: Record<string, unknown>
  changed: string[] // the sections the author edited
  problems: number // what does not fit the schema yet
}

export interface CheckResult extends CheckProgress {
  id: string
  ok: boolean
  reason: string
}

interface Handlers {
  onReady: () => void
  /** Return a reason to refuse the card, or nothing to accept it. */
  onCard?: (received: ReceivedCard) => string | void
  onProgress?: (progress: CheckProgress) => void
  onResult?: (result: CheckResult) => void
}

const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : [])
const isCard = (card: unknown): card is Record<string, unknown> => card !== null && typeof card === 'object' && ('Dataset' in card || 'Model' in card)

/** Listen to one card creator frame. Returns the function that stops listening. */
export function listenToCreator(frame: () => Window | null, creatorOrigin: string, handlers: Handlers): () => void {
  const listen = (event: MessageEvent) => {
    if (event.origin !== creatorOrigin || event.source !== frame()) return
    const data = event.data as { source?: string; type?: string; id?: string; ok?: unknown; reason?: unknown; changed?: unknown; problems?: unknown } & Partial<ReceivedCard>
    if (!data || data.source !== 'roadmap-card-creator') return
    if (data.type === 'ready') handlers.onReady()
    if ((data.type === 'check-progress' || data.type === 'check-result') && isCard(data.card)) {
      const progress = { card: data.card, changed: names(data.changed), problems: Number(data.problems) || 0 }
      if (data.type === 'check-progress') handlers.onProgress?.(progress)
      else handlers.onResult?.({ ...progress, id: String(data.id ?? ''), ok: data.ok === true, reason: typeof data.reason === 'string' ? data.reason : '' })
    }
    if (data.type === 'card' && handlers.onCard) {
      const card = data.card
      const valid = card !== null && typeof card === 'object' && ('Dataset' in card || 'Model' in card)
      const reason = valid
        ? handlers.onCard({
            cardType: 'Dataset' in card! ? 'dataset' : 'model',
            description: String(data.description ?? ''),
            fileName: String(data.fileName ?? 'card.json'),
            card: card!,
          })
        : 'What arrived is not a card.'
      const reply = reason ? { source: 'atlas', type: 'card-rejected', id: data.id, reason } : { source: 'atlas', type: 'card-received', id: data.id }
      ;(event.source as Window).postMessage(reply, event.origin)
    }
  }
  window.addEventListener('message', listen)
  return () => window.removeEventListener('message', listen)
}

/** The author pressed the final button: ask the creator for the card and its verdict. The answer arrives as `onResult` with this id. */
export function askToFinish(frame: Window, creatorOrigin: string, id: string) {
  frame.postMessage({ source: 'atlas', type: 'check-finish', id }, creatorOrigin)
}

/** Ask the card creator to open a card for editing. */
export function openInCreator(frame: Window, creatorOrigin: string, card: CardToOpen) {
  frame.postMessage({ source: 'atlas', type: 'open-card', version: 1, ...card }, creatorOrigin)
}
