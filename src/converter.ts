/**
 * Document-to-Markdown conversion behind one small interface, plus the
 * format router the tool uses. Engines: `@firecrawl/anydoc` for every
 * office format (local Rust napi) and `@firecrawl/pdf-inspector` (WASM in a
 * worker thread) for PDF, where page selection and scanned-page facts matter.
 * @module @jiaoqsh/dsh-document/converter
 */

import { formatFromPath, toMarkdownBytes } from '@firecrawl/anydoc'

/** Formats the engines convert; the value doubles as the model-visible `format` field. */
export const DOCUMENT_FORMATS = [
  'doc', 'docx', 'odt', 'pdf', 'ppt', 'pptx', 'rtf', 'epub', 'xlsx', 'ods', 'odp', 'csv',
] as const

/** One convertible document format. */
export type DocumentFormat = typeof DOCUMENT_FORMATS[number]

/** File extensions (lowercase, no dot) that map to a {@link DocumentFormat}. */
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
 * `ConvertErrorCode`; `empty` means the engine returned no text; `scanned`
 * means a PDF has no extractable text on any requested page; `aborted` means
 * the caller's signal fired; `unknown` wraps an engine failure without a
 * recognized code.
 */
export type ConversionErrorCode =
  | 'unsupported'
  | 'malformed'
  | 'encrypted'
  | 'resourceLimit'
  | 'missingPart'
  | 'io'
  | 'empty'
  | 'scanned'
  | 'pageRange'
  | 'aborted'
  | 'unknown'

/** A conversion failure with a stable code for callers and a model-readable message. */
export class DocumentConversionError extends Error {
  readonly code: ConversionErrorCode

  constructor(message: string, code: ConversionErrorCode) {
    super(message)
    this.name = 'DocumentConversionError'
    this.code = code
  }
}

/** PDF classification, as the model should hear it. */
export type PdfKind = 'text' | 'scanned' | 'image' | 'mixed'

/** Facts a PDF engine reports beside the Markdown. Page numbers are 1-based. */
export interface PdfFacts {
  /** Total pages in the document. */
  pageCount: number
  /** Whether the text layer covers the document. */
  kind: PdfKind
  /** Pages with no extractable text; their content is absent from the Markdown. */
  pagesNeedingOcr: number[]
  /** The pages that were converted, when the request selected some. */
  pages?: number[]
  /** Document title from metadata, when present. */
  title?: string
}

/** One conversion request. */
export interface ConvertRequest {
  /** The whole file. */
  bytes: Uint8Array
  /** The format to parse the bytes as; never sniffed (CSV has no signature). */
  format: DocumentFormat
  /** 1-based pages to convert; PDF only. Absent means every page. */
  pages?: readonly number[]
  /** Cancels a running conversion where the engine allows it. */
  signal: AbortSignal
}

/** One conversion result. */
export interface ConvertResult {
  /** Non-empty GitHub-Flavored Markdown. */
  markdown: string
  /** Present for PDF engines. */
  pdf?: PdfFacts
}

/** One conversion engine. */
export interface DocumentConverter {
  /** Engine identifier for diagnostics. */
  readonly name: string
  /** Formats this engine converts; the router picks the first engine listing a format. */
  readonly formats: readonly DocumentFormat[]
  /**
   * Convert complete document bytes to Markdown.
   * @param request - bytes, format, optional page selection, and cancellation.
   * @returns non-empty Markdown plus engine facts.
   * @throws DocumentConversionError for every engine failure and for cancellation.
   */
  convert(request: ConvertRequest): Promise<ConvertResult>
}

const FORMAT_SET: ReadonlySet<string> = new Set(DOCUMENT_FORMATS)
const ANYDOC_CODES: ReadonlySet<string> = new Set<ConversionErrorCode>([
  'unsupported', 'malformed', 'encrypted', 'resourceLimit', 'missingPart', 'io',
])

/**
 * Map a file path to its document format by extension, case-insensitively.
 * @param path - any path; only the extension is inspected.
 * @returns the format, or `undefined` for an extension no engine handles.
 */
export function formatOf(path: string): DocumentFormat | undefined {
  const format = formatFromPath(path) as string | null
  return format !== null && FORMAT_SET.has(format) ? format as DocumentFormat : undefined
}

/**
 * Pick the engine for a format: the first converter that lists it.
 * @param converters - engines in priority order.
 * @returns a lookup that throws for a format no engine lists.
 */
export function routeConverters(
  converters: readonly DocumentConverter[],
): (format: DocumentFormat) => DocumentConverter {
  return (format) => {
    const converter = converters.find(candidate => candidate.formats.includes(format))
    if (converter === undefined) throw new Error(`document-tools: no engine converts ${format}`)
    return converter
  }
}

/** anydoc's `Format` is a `const enum` in its declarations; runtime values are the same strings. */
type AnydocFormat = NonNullable<Parameters<typeof toMarkdownBytes>[1]>

function anydocError(error: unknown): DocumentConversionError {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : ''
  const message = error instanceof Error ? error.message : String(error)
  return new DocumentConversionError(
    message,
    ANYDOC_CODES.has(code) ? code as ConversionErrorCode : 'unknown',
  )
}

/**
 * The anydoc engine: pure local conversion on the libuv thread pool. It lists
 * every format, so it is the last-resort engine behind any specialized one.
 * @returns the converter.
 */
export function anydocConverter(): DocumentConverter {
  return {
    name: 'anydoc',
    formats: DOCUMENT_FORMATS,
    async convert({ bytes, format, signal }) {
      signal.throwIfAborted()
      let markdown: string
      try {
        markdown = await toMarkdownBytes(bytes, format as unknown as AnydocFormat)
      } catch (error: unknown) {
        throw anydocError(error)
      }
      if (markdown.trim().length === 0) {
        throw new DocumentConversionError('the document contains no extractable text', 'empty')
      }
      return { markdown }
    },
  }
}
