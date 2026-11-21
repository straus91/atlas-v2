// The overview page: what the library holds and where it is thin. Every number is a link to
// the library filtered to exactly those cards.
//
// Colour: datasets are always blue and models always orange (here and on the type badges);
// the coverage grid uses one blue ramp, light for few cards and dark for many.

import { useMemo, useState } from 'react'
import { FILTERS, NEW, NOT_STATED, REVIEWED, isNew, libraryLink, shortMetric } from './library.ts'
import type { Chosen, FilterKey, LibraryCard, LibraryIndex } from './library.ts'

const NO_CARDS: LibraryCard[] = []
type Scope = 'all' | 'dataset' | 'model'
const SCOPES: { key: Scope; label: string }[] = [
  { key: 'all', label: 'All cards' },
  { key: 'dataset', label: 'Datasets' },
  { key: 'model', label: 'Models' },
]
const typeFilter = (scope: Scope): Chosen => (scope === 'all' ? {} : { type: [scope === 'dataset' ? 'Dataset' : 'Model'] })
const plural = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`

function tally<Item>(cards: Item[], values: (card: Item) => string[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const card of cards) for (const value of values(card)) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

const MIN_COLUMN = 5 // columns with fewer cards than this are left out of the coverage table
const MAX_COLUMNS = 12
const MAX_ROWS = 15
const JOURNALS_SHOWN = 12

// What the coverage table can count by. Each is one of the library's filters, so every cell links to its cards.
const DIMENSIONS: { key: FilterKey; label: string; many: string }[] = [
  { key: 'modality', label: 'Modality', many: 'modalities' },
  { key: 'subspecialty', label: 'Subspecialty', many: 'subspecialties' },
  { key: 'task', label: 'Intended use', many: 'intended uses' },
  { key: 'metric', label: 'Metric reported', many: 'metrics' },
  { key: 'population', label: 'Population', many: 'populations' },
  { key: 'year', label: 'Year published', many: 'years' },
  { key: 'type', label: 'Type', many: 'types' },
  { key: 'journal', label: 'Journal', many: 'journals' },
]
const dimensionOf = (key: FilterKey) => DIMENSIONS.find((dimension) => dimension.key === key)!
const specOf = (key: FilterKey) => FILTERS.find((spec) => spec.key === key)!
const shownAs = (key: FilterKey, value: string) => (key === 'metric' ? shortMetric(value) : value)
const COLUMN_HEIGHT = 150 // pixels, the tallest year

/** Which of the six shades a count gets. 0 is reserved for "no cards". */
const STEPS = [1, 3, 6, 11, 21, 41]
const shade = (count: number) => STEPS.filter((from) => count >= from).length
const stepLabel = (index: number) => (index === STEPS.length - 1 ? `${STEPS[index]}+` : STEPS[index] === STEPS[index + 1] - 1 ? `${STEPS[index]}` : `${STEPS[index]}–${STEPS[index + 1] - 1}`)

export default function Overview({ index, failure }: { index: LibraryIndex | null; failure: string | null }) {
  const [scope, setScope] = useState<Scope>('all')
  const [rowKey, setRowKey] = useState<FilterKey>('modality')
  const [columnKey, setColumnKey] = useState<FilterKey>('subspecialty')
  // Rows and columns never count the same thing: choosing what the other one shows swaps them.
  const chooseRows = (key: FilterKey) => (key === columnKey ? (setColumnKey(rowKey), setRowKey(key)) : setRowKey(key))
  const chooseColumns = (key: FilterKey) => (key === rowKey ? (setRowKey(columnKey), setColumnKey(key)) : setColumnKey(key))
  // Drafts are not counted: an administrator is sent them too, but the Overview describes what visitors see.
  const everything = index?.cards ?? NO_CARDS
  const cards = useMemo(() => everything.filter((card) => !card.draft), [everything])
  const drafts = everything.length - cards.length
  const datasets = useMemo(() => cards.filter((card) => card.type === 'dataset'), [cards])
  const models = useMemo(() => cards.filter((card) => card.type === 'model'), [cards])

  if (failure) return <p className="banner bad">{failure}</p>
  if (!index) return <p className="muted">Loading the library…</p>
  if (!cards.length)
    return <p className="banner warn">{index.syncing ? 'The cards are being read from ATLAS for the first time. This takes a minute or two.' : 'The library is empty: the cards could not be read from ATLAS.'}</p>

  const years = cards.map((card) => card.year).filter((year): year is number => year !== null)
  const reviewed = cards.filter((card) => card.author_reviewed).length
  const fresh = cards.filter(isNew).length
  const journals = tally(cards, (card) => (card.journal ? [card.journal] : []))
  const unnamed = cards.filter((card) => !card.journal).length
  // below one in a hundred a rounded share would read as "none"
  const share = reviewed === 0 ? '0%' : reviewed / cards.length < 0.01 ? 'under 1%' : `${Math.round((reviewed / cards.length) * 100)}%`
  return (
    <div className="overview">
      <div className="stat-tiles">
        <a className="stat" href={libraryLink()}><span className="muted">{fresh ? 'Cards' : 'Published cards'}</span><strong>{cards.length}</strong></a>
        {fresh > 0 && (
          <a className="stat" href={libraryLink({ origin: [NEW] })} title="Cards that are not on ATLAS yet, drafted from published papers">
            <span className="muted"><span className="new-mark" aria-hidden="true">✦</span> New, not on ATLAS yet</span><strong>{fresh}</strong>
          </a>
        )}
        <a className="stat" href={libraryLink({ review: [REVIEWED] })} title="Cards whose contact person confirmed or corrected them, with an administrator's final OK">
          <span className="muted"><span className="star" aria-hidden="true">★</span> Author-reviewed · {reviewed} of {cards.length}</span><strong>{share}</strong>
        </a>
        <a className="stat" href={libraryLink({ type: ['Dataset'] })}><span className="muted"><i className="swatch dataset" /> Datasets</span><strong>{datasets.length}</strong></a>
        <a className="stat" href={libraryLink({ type: ['Model'] })}><span className="muted"><i className="swatch model" /> Models</span><strong>{models.length}</strong></a>
        <div className="stat"><span className="muted">Publication years</span><strong>{years.length ? `${Math.min(...years)}–${Math.max(...years)}` : '–'}</strong></div>
      </div>

      {drafts > 0 && (
        <p className="muted fine">
          {drafts} draft{drafts === 1 ? ' is' : 's are'} not counted here, because visitors do not see {drafts === 1 ? 'it' : 'them'}. Publish
          drafts under <a href="#/admin/cards">Cards</a> or <a href="#/admin/submissions">Submissions</a>.
        </p>
      )}

      <section className="panel">
        <div className="chart-head">
          <div>
            <h2>Coverage: {dimensionOf(rowKey).label.toLowerCase()} by {dimensionOf(columnKey).label.toLowerCase()}</h2>
            <p className="muted">
              How many cards cover each combination. Empty cells are gaps in the library. Choose what the rows and the columns count, and
              click a number to see those cards.
            </p>
          </div>
          <div className="segmented small" role="group" aria-label="Cards counted">
            {SCOPES.map(({ key, label }) => (
              <button type="button" key={key} className={scope === key ? 'selected' : ''} aria-pressed={scope === key} onClick={() => setScope(key)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="row pivot-pickers">
          <label className="muted inline">
            Rows{' '}
            <select value={rowKey} onChange={(event) => chooseRows(event.target.value as FilterKey)}>
              {DIMENSIONS.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          <label className="muted inline">
            Columns{' '}
            <select value={columnKey} onChange={(event) => chooseColumns(event.target.value as FilterKey)}>
              {DIMENSIONS.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          <button type="button" className="link" onClick={() => (setRowKey(columnKey), setColumnKey(rowKey))}>Swap rows and columns</button>
        </div>
        <Coverage cards={scope === 'all' ? cards : scope === 'dataset' ? datasets : models} scope={scope} rowKey={rowKey} columnKey={columnKey} />
      </section>

      <div className="chart-pair">
        <section className="panel">
          <h2>Cards by year of publication</h2>
          <p className="muted">The year the dataset or model was published, as the card states it.</p>
          <Years cards={cards} />
        </section>
        <section className="panel">
          <h2>How complete the cards are</h2>
          <p className="muted">The share of cards that state each fact. Click a row to see the cards that leave it out.</p>
          <Completeness cards={cards} datasets={datasets} models={models} />
        </section>
      </div>

      <section className="panel">
        <h2>Where the cards come from</h2>
        <p className="muted">
          The journal of the paper behind each card: the {JOURNALS_SHOWN} journals with the most cards. Click a journal to see its cards.
        </p>
        <Bars rows={journals.slice(0, JOURNALS_SHOWN)} tone="all" link={(value) => libraryLink({ journal: [value] })} unit={['card', 'cards']} />
        <p className="muted fine">
          {journals.length > JOURNALS_SHOWN && `${journals.length - JOURNALS_SHOWN} more journals have ${plural(journals.slice(JOURNALS_SHOWN).reduce((sum, [, count]) => sum + count, 0), 'card', 'cards')} between them. `}
          {unnamed > 0 && `${plural(unnamed, 'card names', 'cards name')} no paper with a journal.`}
        </p>
      </section>

      <div className="chart-pair">
        <section className="panel">
          <h2>What the models do</h2>
          <p className="muted">The ten most common intended uses among the {models.length} model cards.</p>
          <Bars rows={tally(models, (card) => card.tasks).slice(0, 10)} link={(value) => libraryLink({ type: ['Model'], task: [value] })} unit={['model', 'models']} />
        </section>
        <section className="panel">
          <h2>Metrics the models report</h2>
          <p className="muted">The ten most reported performance metrics among the {models.length} model cards.</p>
          <Bars rows={tally(models, (card) => card.metrics).slice(0, 10)} label={shortMetric}
            link={(value) => libraryLink({ type: ['Model'], metric: [value] })} unit={['model', 'models']} />
        </section>
      </div>
    </div>
  )
}

function Coverage({ cards, scope, rowKey, columnKey }: { cards: LibraryCard[]; scope: Scope; rowKey: FilterKey; columnKey: FilterKey }) {
  const [row, column] = [dimensionOf(rowKey), dimensionOf(columnKey)]
  // What each card has for the rows and for the columns, worked out once. "Not stated" is not a row or a column.
  const valued = useMemo(() => {
    const stated = (key: FilterKey, card: LibraryCard) => specOf(key).values(card).filter((value) => value !== NOT_STATED)
    return cards.map((card) => ({ rows: stated(rowKey, card), columns: stated(columnKey, card) }))
  }, [cards, rowKey, columnKey])
  const ordered = (key: FilterKey, counts: [string, number][]) => (key === 'year' ? [...counts].sort((a, b) => b[0].localeCompare(a[0])) : counts)
  const everyRow = ordered(rowKey, tally(valued, (card) => card.rows))
  const everyColumn = ordered(columnKey, tally(valued, (card) => card.columns))
  const rows = everyRow.slice(0, MAX_ROWS)
  const frequent = everyColumn.filter(([, total]) => total >= MIN_COLUMN)
  const columns = (frequent.length ? frequent : everyColumn).slice(0, MAX_COLUMNS) // keep the table readable
  const cell = (rowValue: string, columnValue: string) => valued.filter((card) => card.rows.includes(rowValue) && card.columns.includes(columnValue)).length
  const what = scope === 'dataset' ? ['dataset', 'datasets'] : scope === 'model' ? ['model', 'models'] : ['card', 'cards']
  const [leftRows, leftColumns] = [everyRow.length - rows.length, everyColumn.length - columns.length]
  if (!rows.length || !columns.length) return <p className="muted">No {what[1]} state both of these.</p>
  return (
    <>
      <div className="table-wrap coverage-wrap">
        <table className="coverage">
          <thead>
            <tr>
              <td />
              {columns.map(([name]) => <th key={name} scope="col" title={name}><span>{shownAs(columnKey, name)}</span></th>)}
              <th scope="col" className="total"><span>All {column.many}</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([rowValue, total]) => (
              <tr key={rowValue}>
                <th scope="row" title={rowValue}>{shownAs(rowKey, rowValue)}</th>
                {columns.map(([columnValue]) => {
                  const count = cell(rowValue, columnValue)
                  return (
                    <td key={columnValue}>
                      {count ? (
                        <a className={`heat s${shade(count)}`} href={libraryLink({ ...typeFilter(scope), [rowKey]: [rowValue], [columnKey]: [columnValue] })}
                          title={`${rowValue} · ${columnValue}: ${plural(count, what[0], what[1])}`}>{count}</a>
                      ) : (
                        <span className="heat s0" title={`${rowValue} · ${columnValue}: no ${what[1]}`} />
                      )}
                    </td>
                  )
                })}
                <td className="total"><a href={libraryLink({ ...typeFilter(scope), [rowKey]: [rowValue] })}>{total}</a></td>
              </tr>
            ))}
            <tr className="totals">
              <th scope="row">All {row.many}</th>
              {columns.map(([columnValue, total]) => (
                <td key={columnValue} className="total"><a href={libraryLink({ ...typeFilter(scope), [columnKey]: [columnValue] })}>{total}</a></td>
              ))}
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <p className="legend muted">
        <span className="heat s0 key" /> none
        {STEPS.map((_, index) => (
          <span key={index} className="legend-item"><span className={`heat s${index + 1} key`} /> {stepLabel(index)}</span>
        ))}
        <span className="legend-note">
          A card with two {row.many} or {column.many} is counted in each.
          {leftColumns > 0 && ` Not shown: ${leftColumns} ${column.many} with fewer ${what[1]}.`}
          {leftRows > 0 && ` Only the ${MAX_ROWS} ${row.many} with the most ${what[1]} are shown; ${leftRows} more are not.`}
        </span>
      </p>
    </>
  )
}

function Years({ cards }: { cards: LibraryCard[] }) {
  const stated = cards.filter((card) => card.year !== null)
  if (!stated.length) return <p className="muted">No card states a year.</p>
  const first = Math.min(...stated.map((card) => card.year!))
  const last = Math.max(...stated.map((card) => card.year!))
  const years = Array.from({ length: last - first + 1 }, (_, offset) => first + offset)
  const of = (year: number, type: LibraryCard['type']) => stated.filter((card) => card.year === year && card.type === type).length
  const tallest = Math.max(...years.map((year) => of(year, 'dataset') + of(year, 'model')))
  const missing = cards.length - stated.length
  return (
    <>
      <p className="legend muted">
        <span className="legend-item"><i className="swatch dataset" /> Datasets</span>
        <span className="legend-item"><i className="swatch model" /> Models</span>
      </p>
      <div className="columns-chart" role="img" aria-label={`Cards published per year, ${first} to ${last}`}>
        {years.map((year) => {
          const [datasets, models] = [of(year, 'dataset'), of(year, 'model')]
          const total = datasets + models
          return (
            <a className="column" key={year} href={libraryLink({ year: [String(year)] })}
              title={`${year}: ${plural(datasets, 'dataset', 'datasets')}, ${plural(models, 'model', 'models')}`}>
              <span className="column-value">{total || ''}</span>
              <span className="column-stack" style={{ height: `${Math.round((total / tallest) * COLUMN_HEIGHT)}px` }}>
                {models > 0 && <span className="segment model" style={{ flexGrow: models }} />}
                {datasets > 0 && <span className="segment dataset" style={{ flexGrow: datasets }} />}
              </span>
              <span className="column-label">{String(year).slice(2).padStart(3, '’')}</span>
            </a>
          )
        })}
      </div>
      {missing > 0 && (
        <p className="muted fine">
          <a href={libraryLink({ year: [NOT_STATED] })}>{plural(missing, 'card does', 'cards do')} not state a year</a>.
        </p>
      )}
    </>
  )
}

interface BarsProps {
  rows: [string, number][]
  link: (value: string) => string
  unit: [string, string]
  label?: (value: string) => string
  /** The bars' colour: orange for models (the default), neutral when the cards are of both kinds. */
  tone?: 'model' | 'all'
}

/** Horizontal bars, most frequent first, the count at the tip. One series, so no legend. */
function Bars({ rows, link, unit, label = (value) => value, tone = 'model' }: BarsProps) {
  const longest = Math.max(1, ...rows.map(([, count]) => count))
  if (!rows.length) return <p className="muted">No card states this.</p>
  return (
    <ul className="bars">
      {rows.map(([value, count]) => (
        <li key={value}>
          <a href={link(value)} title={`${value}: ${plural(count, unit[0], unit[1])}`}>
            <span className="bar-label">{label(value)}</span>
            <span className="bar-track"><span className={`bar ${tone}`} style={{ width: `calc((100% - 44px) * ${count / longest})` }} /><span className="bar-value">{count}</span></span>
          </a>
        </li>
      ))}
    </ul>
  )
}

function Completeness({ cards, datasets, models }: { cards: LibraryCard[]; datasets: LibraryCard[]; models: LibraryCard[] }) {
  const rows: { label: string; of: LibraryCard[]; group: Scope; has: (card: LibraryCard) => boolean; missing?: Chosen }[] = [
    { label: 'Year of publication', of: cards, group: 'all', has: (card) => card.year !== null, missing: { year: [NOT_STATED] } },
    { label: 'License', of: cards, group: 'all', has: (card) => card.license !== '', missing: { license: [NOT_STATED] } },
    { label: 'ATLAS description', of: cards, group: 'all', has: (card) => card.has_atlas_description },
    { label: 'Number of patients', of: datasets, group: 'dataset', has: (card) => Boolean(card.sizes.patient) },
    { label: 'Any size (patients, exams, images…)', of: datasets, group: 'dataset', has: (card) => Object.keys(card.sizes).length > 0 },
    { label: 'Age range', of: datasets, group: 'dataset', has: (card) => card.ages !== null },
    { label: 'Intended use (task)', of: models, group: 'model', has: (card) => card.tasks.length > 0 },
    { label: 'Performance results', of: models, group: 'model', has: (card) => card.has_performance },
  ]
  const groupName = { all: 'All cards', dataset: 'Datasets', model: 'Models' }
  return (
    <ul className="bars meters">
      {rows.map((row, index) => {
        const have = row.of.filter(row.has).length
        const share = row.of.length ? Math.round((have / row.of.length) * 100) : 0
        const content = (
          <>
            <span className="bar-label">{row.label}<span className="muted block">{groupName[row.group]}</span></span>
            <span className="bar-track">
              <span className="meter"><span className={`bar ${row.group}`} style={{ width: `${share}%` }} /></span>
              <span className="bar-value">{share}%<span className="muted"> · {have} of {row.of.length}</span></span>
            </span>
          </>
        )
        const missing = row.missing ? libraryLink({ ...typeFilter(row.group), ...row.missing }) : null
        return (
          <li key={index}>
            {missing ? <a href={missing} title={`See the ${row.of.length - have} cards that do not state this`}>{content}</a> : <div className="bar-row">{content}</div>}
          </li>
        )
      })}
    </ul>
  )
}
