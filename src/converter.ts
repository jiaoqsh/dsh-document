/**
 * Document-to-Markdown conversion behind one small interface. The current
 * engine is `@firecrawl/anydoc` (local Rust, no network); the interface exists
 * so a PDF-specialized or hosted engine can be routed per format later
 * without changing the model-facing tool.
 * @module @jiaoqsh/dsh-document/converter
 */

import { formatFromPath, toMarkdownBytes } from '@firecrawl/anydoc'

/** Formats the current engine converts; the value doubles as the model-visible `format` field. */
export const DOCUMENT_FORMATS = [
  'doc', 'docx', 'odt', 'pdf', 'ppt', 'pptx', 'rtf', 'epub', 'xlsx', 'ods', 'odp', 'csv',
] as const

/** One convertible document format. */
export type DocumentFormat = typeof DOCUMENT_FORMATS[number]

/** File extensions (lowercase, no dot) the engine maps to a {@link DocumentFormat}. */
export const DOCUMENT_EXTENSIONS = [
  'pdf',
  'doc', 'docm', 'docx',
  'ppt', 'pps', 'pot', 'pptx', 'pptm', 'ppsx', 'ppsm',
  'xls', 'xlsx', 'xlsm', 'xlsb',
  'odt', 'ods', 'odp',
  'rtf', 'epub', 'csv',
] as const

/**
 * Failure classes a conversion can report. The first six mirror anydoc's
 * `ConvertErrorCode`; `empty` means the engine returned no text; `unknown`
 * wraps an engine failure without a recognized code.
 */
export type ConversionErrorCode =
  | 'unsupported'
  | 'malformed'
  | 'encrypted'
  | 'resourceLimit'
  | 'missingPart'
  | 'io'
  | 'empty'
  | 'unknown'

/** A conversion failure with a stable code for callers and a model-readable message. */
export class DocumentConversionError extends Error {
  constructor(message: string, readonly code: ConversionErrorCode) {
    super(message)
    this.name = 'DocumentConversionError'
  }
}

/** One conversion engine. */
export interface DocumentConverter {
  /** Engine identifier for diagnostics. */
  readonly name: string
  /**
   * Map a file path to the format the engine would convert it as.
   * @param path - any path; only its extension is inspected, case-insensitively.
   * @returns the format, or `undefined` when the engine does not handle the extension.
   */
  formatOf(path: string): DocumentFormat | undefined
  /**
   * Convert complete document bytes to GitHub-Flavored Markdown.
   * @param bytes - the whole file.
   * @param format - the format to parse the bytes as (never sniffed: CSV has no signature).
   * @returns non-empty Markdown.
   * @throws DocumentConversionError for every engine failure.
   */
  toMarkdown(bytes: Uint8Array, format: DocumentFormat): Promise<string>
}

const FORMAT_SET: ReadonlySet<string> = new Set(DOCUMENT_FORMATS)
const CODE_SET: ReadonlySet<string> = new Set<ConversionErrorCode>([
  'unsupported', 'malformed', 'encrypted', 'resourceLimit', 'missingPart', 'io',
])

/** anydoc's `Format` is a `const enum` in its declarations; runtime values are the same strings. */
type AnydocFormat = NonNullable<Parameters<typeof toMarkdownBytes>[1]>

function conversionError(error: unknown): DocumentConversionError {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : ''
  const message = error instanceof Error ? error.message : String(error)
  return new DocumentConversionError(
    message,
    CODE_SET.has(code) ? code as ConversionErrorCode : 'unknown',
  )
}

/**
 * The anydoc engine: pure local conversion on the libuv thread pool.
 * @returns a converter that handles every {@link DOCUMENT_FORMATS} member.
 */
export function anydocConverter(): DocumentConverter {
  return {
    name: 'anydoc',
    formatOf(path) {
      const format = formatFromPath(path) as string | null
      return format !== null && FORMAT_SET.has(format) ? format as DocumentFormat : undefined
    },
    async toMarkdown(bytes, format) {
      let markdown: string
      try {
        markdown = await toMarkdownBytes(bytes, format as unknown as AnydocFormat)
      } catch (error: unknown) {
        throw conversionError(error)
      }
      if (markdown.trim().length === 0) {
        throw new DocumentConversionError('the document contains no extractable text', 'empty')
      }
      return markdown
    },
  }
}
