// The library of published ATLAS cards: what the server knows about each card, and the
// searching, filtering and counting the Library and Overview pages share. Pure functions only.

export interface LibraryCard {
  id: string
  type: 'dataset' | 'model'
  title: string
  name: string
  summary: string
  has_atlas_description: boolean
  atlas_url: string
  link: string
  modalities: string[]
  subspecialties: string[]
  content_codes: string[]
  tasks: string[]
  metrics: string[]
  population: string
  ages: [number, number] | null
  year: number | null
  license: string
  organizations: string[]
  sizes: Partial<Record<SizeKind, number>>
  formats: string[]
  architecture: string
  has_performance: boolean
  /** Result values read from the card's performance text by AI, each checked to appear in it. */
  results: ReadResult[]
  results_read: boolean
  search: string
  /** A draft: hidden from visitors until an administrator publishes it. Only administrators are ever sent one. */
  draft?: boolean
  /** Someone sent this card from the Creator page. */
  submission?: boolean
  /** When the card was marked as author-reviewed: its contact person confirmed or corrected it and an administrator gave the final OK. */
  author_reviewed?: string | null
  /** The card shown is its author's corrected version, not ATLAS's copy. */
  author_edited?: boolean
  /** 'new': the card is not on ATLAS; an administrator added it here (for example drafted from a paper). */
  origin?: 'atlas' | 'new'
  /** The paper a new card was drafted from. */
  paper?: Paper | null
  /** The journal of the card's paper, named in full: of the paper a new card was drafted from, else of the card's first reference. */
  journal?: string
}

export interface Paper {
  title?: string
  journal?: string
  year?: string
  doi?: string
  pmid?: string
  pmcid?: string
  citations?: string
}

export interface ReadResult {
  set: string // what it was measured on
  metric: string
  value: string // exactly as printed in the card's text
  detail: string // confidence interval, range, or a short note
}

export interface LibraryIndex {
  cards: LibraryCard[]
  count: number
  synced_at: string | null
  last_error: string | null
  syncing: boolean
  source: string
}

export interface LibraryRecord {
  card: Record<string, unknown>
  title: string
  description: string
  facts: LibraryCard | null
}

export type SizeKind = 'patient' | 'exam' | 'series' | 'image' | 'site'
export const SIZE_KINDS: { kind: SizeKind; one: string; many: string }[] = [
  { kind: 'patient', one: 'patient', many: 'patients' },
  { kind: 'exam', one: 'exam', many: 'exams' },
  { kind: 'image', one: 'image', many: 'images' },
  { kind: 'series', one: 'series', many: 'series' },
  { kind: 'site', one: 'site', many: 'sites' },
]

export interface Health {
  cards: number
  creator_url: string // the card creator shown on the Creator page; empty when there is none
  creator_origin: string
}

export async function getHealth(): Promise<Health> {
  const response = await fetch('/api/health')
  if (!response.ok) throw new Error(`The server answered with an error (${response.status}).`)
  return (await response.json()) as Health
}

/** Send a card received from the creator for review. It waits as a draft until an administrator publishes it. */
export async function submitCard(card: Record<string, unknown>, description: string, name: string, email: string): Promise<{ title: string }> {
  const response = await fetch('/api/submissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ card, description, name: name.trim(), email: email.trim() }),
  })
  if (response.ok) return (await response.json()) as { title: string }
  let reason = `The card could not be sent (${response.status}). Check the connection and try again.`
  try {
    const detail = ((await response.json()) as { detail?: unknown }).detail
    if (typeof detail === 'string') reason = detail
  } catch {
    // not a message from the site itself: keep the plain reason
  }
  throw new Error(reason)
}

// A signed-in administrator reads the library through an address of their own, which also gives the drafts.
let asAdmin = false
export function readAsAdmin(on: boolean) {
  asAdmin = on
}

/** Fetch from the library; if the administrator's session has ended, as a visitor. */
async function fromLibrary(path: string): Promise<Response> {
  if (asAdmin) {
    const response = await fetch(`/api/admin/library${path}`, { credentials: 'same-origin' })
    if (response.status !== 401) return response
    asAdmin = false
  }
  return fetch(`/api/library${path}`)
}

export async function getLibrary(): Promise<LibraryIndex> {
  const response = await fromLibrary('')
  if (!response.ok) throw new Error(`The library could not be loaded (${response.status}).`)
  const index = (await response.json()) as LibraryIndex & { author_reviewed?: Record<string, string> }
  const marks = index.author_reviewed ?? {}
  return { ...index, cards: index.cards.map((card) => ({ ...card, author_reviewed: marks[card.id] ?? null })) }
}

export async function getLibraryCard(id: string): Promise<LibraryRecord> {
  const response = await fromLibrary(`/${encodeURIComponent(id)}`)
  if (response.status === 404) throw new Error('That card is not in the library.')
  if (!response.ok) throw new Error(`The card could not be loaded (${response.status}).`)
  return (await response.json()) as LibraryRecord
}

/** Save a card to the visitor's computer as a JSON file. */
export function saveCard(card: unknown, title: string, type: 'dataset' | 'model') {
  const url = URL.createObjectURL(new Blob([JSON.stringify(card, null, 2) + '\n'], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${title.replace(/[^\w.-]+/g, '_').slice(0, 80)}.${type}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

/** Fetch a card from the library and save it, without opening its page. */
export async function downloadCard(card: LibraryCard): Promise<void> {
  const record = await getLibraryCard(card.id)
  saveCard(record.card, card.title || 'card', card.type)
}

// ------------------------------------------------------------------ filters
export type FilterKey = 'type' | 'modality' | 'subspecialty' | 'task' | 'population' | 'year' | 'metric' | 'license' | 'size' | 'review' | 'origin' | 'journal' | 'status'

export interface FilterSpec {
  key: FilterKey
  label: string
  /** Shown in the bar itself; the others sit under "More". */
  main: boolean
  /** The values a card has for this filter. A card matches when it has any chosen value. */
  values: (card: LibraryCard) => string[]
  /** Fixed order of the options; otherwise most frequent first. */
  order?: string[]
}

export const NOT_STATED = 'Not stated'
export const PUBLISHED = 'Published'
export const DRAFT = 'Draft (hidden from visitors)'
export const REVIEWED = 'Author-reviewed'
export const NOT_REVIEWED = 'Not author-reviewed'
export const ON_ATLAS = 'On ATLAS'
export const NEW = 'New (not on ATLAS yet)'
export const isNew = (card: Pick<LibraryCard, 'origin'>) => card.origin === 'new'

export const FILTERS: FilterSpec[] = [
  { key: 'type', label: 'Type', main: true, values: (card) => [card.type === 'dataset' ? 'Dataset' : 'Model'], order: ['Dataset', 'Model'] },
  { key: 'modality', label: 'Modality', main: true, values: (card) => (card.modalities.length ? card.modalities : [NOT_STATED]) },
  { key: 'subspecialty', label: 'Subspecialty', main: true, values: (card) => (card.subspecialties.length ? card.subspecialties : [NOT_STATED]) },
  { key: 'task', label: 'Task', main: true, values: (card) => card.tasks },
  { key: 'population', label: 'Population', main: true, values: (card) => [card.population], order: ['Pediatric', 'Adult', 'Children and adults', NOT_STATED] },
  { key: 'year', label: 'Published', main: true, values: (card) => [card.year === null ? NOT_STATED : String(card.year)] },
  { key: 'metric', label: 'Metric reported', main: false, values: (card) => card.metrics },
  { key: 'license', label: 'License', main: false, values: (card) => [card.license ? 'Stated' : NOT_STATED], order: ['Stated', NOT_STATED] },
  {
    key: 'size', label: 'Size given as', main: false,
    values: (card) => SIZE_KINDS.filter(({ kind }) => card.sizes[kind]).map(({ many }) => many[0].toUpperCase() + many.slice(1)),
  },
  // Only offered once at least one card carries the mark.
  { key: 'review', label: 'Author review', main: false, values: (card) => [card.author_reviewed ? REVIEWED : NOT_REVIEWED], order: [REVIEWED, NOT_REVIEWED] },
  // Only offered when the library holds cards that are not on ATLAS.
  { key: 'origin', label: 'Source', main: false, values: (card) => [isNew(card) ? NEW : ON_ATLAS], order: [ON_ATLAS, NEW] },
  { key: 'journal', label: 'Journal', main: false, values: (card) => (card.journal ? [card.journal] : []) },
  // Shown as a switch above the filters, not in a menu, and only to an administrator who has drafts.
  { key: 'status', label: 'Status', main: false, values: (card) => [card.draft ? DRAFT : PUBLISHED], order: [DRAFT, PUBLISHED] },
]

export type Chosen = Partial<Record<FilterKey, string[]>>

export interface Query {
  text: string
  chosen: Chosen
}

const words = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean)

function passes(card: LibraryCard, query: Query, except?: FilterKey): boolean {
  for (const word of words(query.text)) if (!card.search.includes(word)) return false
  for (const spec of FILTERS) {
    const wanted = query.chosen[spec.key]
    if (spec.key === except || !wanted?.length) continue
    const has = spec.values(card)
    if (!wanted.some((value) => has.includes(value))) return false
  }
  return true
}

/** The cards that match every word typed and, for each filter in use, at least one chosen value. */
export function filterCards(cards: LibraryCard[], query: Query): LibraryCard[] {
  return cards.filter((card) => passes(card, query))
}

export interface Option {
  value: string
  count: number
}

/** A filter's options with how many cards each would give, with the other filters as they are. */
export function optionsFor(cards: LibraryCard[], query: Query, spec: FilterSpec): Option[] {
  const counts = new Map<string, number>()
  for (const card of cards) {
    if (!passes(card, query, spec.key)) continue
    for (const value of spec.values(card)) counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  for (const value of query.chosen[spec.key] ?? []) if (!counts.has(value)) counts.set(value, 0)
  const options = [...counts].map(([value, count]) => ({ value, count }))
  if (spec.order) {
    const rank = (value: string) => (spec.order!.includes(value) ? spec.order!.indexOf(value) : spec.order!.length)
    return options.sort((a, b) => rank(a.value) - rank(b.value))
  }
  if (spec.key === 'year') return options.sort((a, b) => (a.value === NOT_STATED ? 1 : b.value === NOT_STATED ? -1 : b.value.localeCompare(a.value)))
  return options.sort((a, b) => (a.value === NOT_STATED ? 1 : b.value === NOT_STATED ? -1 : b.count - a.count || a.value.localeCompare(b.value)))
}

// ------------------------------------------------------------------ sorting and wording
export type SortKey = 'title' | 'newest' | 'oldest' | 'largest'
export const SORTS: { key: SortKey; label: string }[] = [
  { key: 'newest', label: 'Newest publication' },
  { key: 'oldest', label: 'Oldest publication' },
  { key: 'title', label: 'Name (A to Z)' },
  { key: 'largest', label: 'Most patients' },
]

// The order is the newest first unless the visitor chose another one, which is then kept for their next visit.
const SORT_KEY = 'atlas-v2-library-sort'
export function readSort(): SortKey {
  try {
    const saved = localStorage.getItem(SORT_KEY)
    return SORTS.some((sort) => sort.key === saved) ? (saved as SortKey) : 'newest'
  } catch {
    return 'newest'
  }
}
export function rememberSort(key: SortKey) {
  try {
    localStorage.setItem(SORT_KEY, key)
  } catch {
    // private window: the choice simply is not remembered
  }
}

export function sortCards(cards: LibraryCard[], key: SortKey): LibraryCard[] {
  const byTitle = (a: LibraryCard, b: LibraryCard) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
  const sorted = [...cards]
  if (key === 'title') return sorted.sort(byTitle)
  if (key === 'largest') return sorted.sort((a, b) => (b.sizes.patient ?? -1) - (a.sizes.patient ?? -1) || byTitle(a, b))
  const missing = key === 'newest' ? -Infinity : Infinity
  return sorted.sort((a, b) => {
    const [first, second] = [a.year ?? missing, b.year ?? missing]
    return (key === 'newest' ? second - first : first - second) || byTitle(a, b)
  })
}

/** "Nov 20, 2026" from a day or a full timestamp as the server gives it. */
export function day(value: string | null | undefined): string {
  if (!value) return ''
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], { dateStyle: 'medium' })
}

export function count(value: number, one: string, many: string): string {
  return `${value.toLocaleString('en-US')} ${value === 1 ? one : many}`
}

/** "43 patients · 110 series": the sizes a card gives, most telling first. */
export function sizeParts(card: LibraryCard): string[] {
  return SIZE_KINDS.filter(({ kind }) => card.sizes[kind]).map(({ kind, one, many }) => count(card.sizes[kind]!, one, many))
}

const SHORT_METRIC: Record<string, string> = {
  'area under the receiver operating characteristic curve': 'AUC',
  'Dice similarity coefficient': 'Dice',
  'positive predictive value': 'PPV',
  'negative predictive value': 'NPV',
  'receiver operating characteristic analysis': 'ROC analysis',
  'intraclass correlation coefficient': 'ICC',
  'mean absolute error': 'MAE',
  'intersection over union': 'IoU',
  'normalized surface distance': 'NSD',
}

export function shortMetric(metric: string): string {
  return SHORT_METRIC[metric] ?? metric
}

/** The metrics that have result values among these cards, most frequent first: [metric, cards]. */
export function metricsWithValues(cards: LibraryCard[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const card of cards) for (const metric of new Set(card.results.map((result) => result.metric))) counts.set(metric, (counts.get(metric) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/** A card's results for one metric, in the order its text gives them (the headline comes first). */
export function resultsFor(card: LibraryCard, metric: string): ReadResult[] {
  const wanted = metric.toLowerCase()
  return card.results.filter((result) => result.metric.toLowerCase() === wanted)
}

// ------------------------------------------------------------------ the address bar
/** Filters live in the page address, so a filtered view can be linked to and shared. */
export function queryToParams(query: Query): string {
  const params = new URLSearchParams()
  if (query.text.trim()) params.set('q', query.text.trim())
  for (const spec of FILTERS) for (const value of query.chosen[spec.key] ?? []) params.append(spec.key, value)
  const text = params.toString()
  return text ? `?${text}` : ''
}

export function paramsToQuery(params: URLSearchParams): Query {
  const chosen: Chosen = {}
  for (const spec of FILTERS) {
    const values = params.getAll(spec.key)
    if (values.length) chosen[spec.key] = values
  }
  return { text: params.get('q') ?? '', chosen }
}

export function libraryLink(chosen: Chosen = {}, text = ''): string {
  return `#/library${queryToParams({ text, chosen })}`
}
