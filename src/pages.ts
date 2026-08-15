/**
 * The `pages` argument grammar: comma-separated 1-based page numbers and
 * inclusive ranges, e.g. `"1-3,7,10-12"`.
 * @module @jiaoqsh/dsh-document/pages
 */

const TOKEN = /^(\d+)(?:-(\d+))?$/

/**
 * Parse a page selection into a sorted, de-duplicated list.
 * @param spec - the model-supplied text.
 * @param maxPages - the largest number of distinct pages one call may select.
 * @returns ascending 1-based page numbers.
 * @throws Error naming the offending token, or the count when it exceeds `maxPages`.
 */
export function parsePages(spec: string, maxPages: number): number[] {
  const pages = new Set<number>()
  for (const rawToken of spec.split(',')) {
    const token = rawToken.trim()
    const match = TOKEN.exec(token)
    if (match === null) {
      throw new Error(`pages must be comma-separated page numbers or ranges like "1-3,7", got "${token}"`)
    }
    const first = Number(match[1])
    const last = match[2] === undefined ? first : Number(match[2])
    if (first < 1 || last < first) throw new Error(`pages contains an invalid range "${token}"`)
    if (last - first + 1 > maxPages || pages.size + (last - first + 1) > maxPages) {
      throw new Error(`pages selects more than ${maxPages} pages`)
    }
    for (let page = first; page <= last; page += 1) pages.add(page)
  }
  if (pages.size === 0) throw new Error('pages must select at least one page')
  return [...pages].sort((a, b) => a - b)
}
