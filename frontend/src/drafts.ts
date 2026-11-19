// Cards received from the card creator.
//
// This proposal site has no accounts and no storage of its own, so a card sent from the creator
// is kept in the visitor's own browser and shown in Browse as a draft that only they can see.
// (On the real ATLAS the same hand-over would save the card as a draft in the person's account.)
// Nothing here is sent to the server, and one visitor's drafts are never shown to another.

import { DRAFT } from './library.ts'
import type { LibraryCard, LibraryRecord } from './library.ts'

const KEY = 'atlas-v2-drafts'
const MAX_DRAFTS = 20
export const DRAFT_STATUS = DRAFT

export const isDraftId = (id: string) => id.startsWith('draft-')

export function readDrafts(): LibraryRecord[] {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '[]') as LibraryRecord[]
    return Array.isArray(saved) ? saved.filter((record) => record && record.card && record.facts && isDraftId(record.facts.id)) : []
  } catch {
    return []
  }
}

export function writeDrafts(drafts: LibraryRecord[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(drafts.slice(0, MAX_DRAFTS)))
  } catch {
    // private window or full storage: the draft lasts until the page is closed
  }
}

/** Turn a card the server has just described into a draft with an id of its own. */
export function asDraft(record: LibraryRecord): LibraryRecord {
  const facts = { ...(record.facts as LibraryCard), id: `draft-${Date.now()}`, draft: true, atlas_url: '' }
  return { ...record, title: facts.title, facts }
}
