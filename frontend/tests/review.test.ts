// Author review: which cards carry the mark, which contacts can be asked, and which address is used.
import { describe, expect, it } from 'vitest'
import { FILTERS, NOT_REVIEWED, NOT_STATED, REVIEWED, filterCards, optionsFor } from '../src/library.ts'
import type { LibraryCard } from '../src/library.ts'
import { addressFor, canAsk, isAddress, nameFor, stageOf } from '../src/review.ts'
import type { AdminRow, Review } from '../src/review.ts'
import { parseRoute } from '../src/route.ts'

const card = (over: Partial<LibraryCard>): LibraryCard => ({
  id: over.title ?? 'x', type: 'dataset', title: 'Untitled', name: '', summary: '', has_atlas_description: false, atlas_url: '', link: '',
  modalities: [], subspecialties: [], content_codes: [], tasks: [], metrics: [], population: NOT_STATED, ages: null, year: null,
  license: '', organizations: [], sizes: {}, formats: [], architecture: '', has_performance: false, results: [], results_read: false, search: '',
  ...over,
})
const review = (over: Partial<Review>): Review => ({ status: 'requested', changed: false, ...over })
const row = (over: Partial<AdminRow>): AdminRow => ({ id: 'a', title: 'A card', type: 'model', contacts: [], review: null, ...over })

describe('the author-reviewed mark', () => {
  const cards = [card({ title: 'Reviewed set', author_reviewed: '2026-11-20' }), card({ title: 'Plain set', author_reviewed: null }), card({ title: 'Draft' })]
  const spec = FILTERS.find((filter) => filter.key === 'review')!

  it('can be filtered on, and counts the cards that carry it', () => {
    expect(filterCards(cards, { text: '', chosen: { review: [REVIEWED] } }).map((found) => found.title)).toEqual(['Reviewed set'])
    expect(optionsFor(cards, { text: '', chosen: {} }, spec)).toEqual([{ value: REVIEWED, count: 1 }, { value: NOT_REVIEWED, count: 2 }])
  })

  it('has its pages in the address', () => {
    expect(parseRoute('#/admin').page).toBe('admin')
    expect(parseRoute('#/validate/abc-DEF_123')).toMatchObject({ page: 'validate', id: 'abc-DEF_123' })
    expect(parseRoute('#/validate').page).toBe('library') // a link without its key leads nowhere special
  })
})

describe('where a review stands', () => {
  it('follows the steps, and a changed card needs asking again', () => {
    expect(stageOf(null)).toBe('none')
    expect(stageOf(review({ status: 'requested' }))).toBe('requested')
    expect(stageOf(review({ status: 'confirmed' }))).toBe('confirmed')
    expect(stageOf(review({ status: 'approved' }))).toBe('approved')
    expect(stageOf(review({ status: 'approved', changed: true }))).toBe('stale')
    expect(stageOf(review({ status: 'confirmed', changed: true }))).toBe('stale')
    expect(stageOf(review({ status: 'changes', changed: true }))).toBe('changes')
  })

  it('lets a contact be asked unless an answer waits for the final OK or the mark is given', () => {
    expect((['none', 'requested', 'changes', 'stale'] as const).every(canAsk)).toBe(true)
    expect(canAsk('confirmed') || canAsk('approved')).toBe(false)
  })

  it('uses the typed address first, then the one asked before, then the first contact of the card', () => {
    const contacts = [{ email: 'Ann@example.org', name: 'Ann Lee', source: "the card's contact" }, { email: 'bo@example.org', name: '', source: "the card's authors" }]
    expect(addressFor(row({ contacts }), undefined)).toBe('Ann@example.org')
    expect(addressFor(row({ contacts, review: review({ email: 'bo@example.org' }) }), undefined)).toBe('bo@example.org')
    expect(addressFor(row({ contacts }), ' new@example.org ')).toBe('new@example.org')
    expect(addressFor(row({ contacts }), '')).toBe('') // cleared on purpose: nothing is filled in behind the administrator's back
    expect(nameFor(row({ contacts }), 'ann@EXAMPLE.org')).toBe('Ann Lee')
    expect(nameFor(row({ contacts }), 'new@example.org')).toBe('')
    expect(isAddress('ann@example.org') && !isAddress('ann@example') && !isAddress('not an address')).toBe(true)
  })
})
