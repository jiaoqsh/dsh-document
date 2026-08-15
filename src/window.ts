/**
 * Line windowing over converted Markdown: offset/limit paging, per-line
 * character truncation, and a byte cap on the complete selected output.
 * @module @jiaoqsh/dsh-document/window
 */

/** Paging and bounds for one window. */
export interface WindowRequest {
  /** 1-based first line to return. */
  offset: number
  /** Maximum number of lines to return. */
  limit: number
  /** Maximum characters per returned line; overflow is cut with a marker. */
  maxLineLength: number
  /** Maximum UTF-8 bytes of all returned line text; overflow stops the window. */
  maxBytes: number
}

/** One returned line. */
export interface WindowLine {
  /** 1-based line number in the converted document. */
  number: number
  /** Line text after per-line truncation. */
  text: string
}

/** The selected window plus what it left out. */
export interface WindowResult {
  lines: WindowLine[]
  /** Exact line count of the converted document. */
  totalLines: number
  /** Whether the byte cap ended the window before `limit` lines. */
  truncatedByBytes: boolean
}

const TRUNCATION_MARKER = '… [line truncated]'
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: false })

/**
 * Split converted text into lines: a trailing newline does not open an empty
 * final line, and empty text has zero lines.
 * @param text - the converted document.
 * @returns lines without their terminators; CRLF is normalized.
 */
export function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/** Cut a string to at most `maxBytes` UTF-8 bytes on a character boundary. */
function cutToBytes(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text)
  if (bytes.byteLength <= maxBytes) return text
  let end = maxBytes
  // Back off continuation bytes (10xxxxxx) so the cut never splits a code point.
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1
  return decoder.decode(bytes.subarray(0, end))
}

/**
 * Select one window of lines under every bound.
 * @param text - the converted document.
 * @param request - paging and bounds; callers validate that all are positive integers.
 * @returns the window; a first line larger than `maxBytes` is cut rather than dropped so
 *   the caller always makes progress.
 */
export function windowLines(text: string, request: WindowRequest): WindowResult {
  const all = splitLines(text)
  const lines: WindowLine[] = []
  let bytes = 0
  let truncatedByBytes = false
  const last = Math.min(all.length, request.offset - 1 + request.limit)
  for (let index = request.offset - 1; index < last; index += 1) {
    let line = all[index]!
    if (line.length > request.maxLineLength) {
      line = `${line.slice(0, request.maxLineLength)}${TRUNCATION_MARKER}`
    }
    let size = encoder.encode(line).byteLength
    if (bytes + size > request.maxBytes) {
      if (lines.length > 0) {
        truncatedByBytes = true
        break
      }
      line = cutToBytes(line, request.maxBytes)
      size = encoder.encode(line).byteLength
      truncatedByBytes = true
    }
    lines.push({ number: index + 1, text: line })
    bytes += size
  }
  return { lines, totalLines: all.length, truncatedByBytes }
}
