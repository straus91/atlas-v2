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
}

interface Handlers {
  onReady: () => void
  /** Return a reason to refuse the card, or nothing to accept it. */
  onCard: (received: ReceivedCard) => string | void
}

/** Listen to one card creator frame. Returns the function that stops listening. */
export function listenToCreator(frame: () => Window | null, creatorOrigin: string, handlers: Handlers): () => void {
  const listen = (event: MessageEvent) => {
    if (event.origin !== creatorOrigin || event.source !== frame()) return
    const data = event.data as { source?: string; type?: string; id?: string } & Partial<ReceivedCard>
    if (!data || data.source !== 'roadmap-card-creator') return
    if (data.type === 'ready') handlers.onReady()
    if (data.type === 'card') {
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

/** Ask the card creator to open a card for editing. */
export function openInCreator(frame: Window, creatorOrigin: string, card: CardToOpen) {
  frame.postMessage({ source: 'atlas', type: 'open-card', version: 1, ...card }, creatorOrigin)
}
