/**
 * The model-facing `read_document` tool: resolve a path through `ctx.fs`,
 * read the bytes under the input cap, convert them to Markdown through the
 * routed engine, and return one line-numbered window. PDFs additionally
 * accept a page selection and report page facts.
 * @module @jiaoqsh/dsh-document/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  DOCUMENT_EXTENSIONS,
  DOCUMENT_FORMATS,
  DocumentConversionError,
  formatOf,
  type DocumentConverter,
  type DocumentFormat,
  type PdfFacts,
} from './converter.ts'
import { parsePages } from './pages.ts'
import { formatPages } from './pdf-inspector.ts'
import { windowLines, type WindowLine } from './window.ts'

/** Deployment bounds after defaulting (see `Config` in index.ts). */
export interface ReadDocumentCaps {
  /** Inclusive byte cap on the source file; larger files are refused before conversion. */
  maxInputBytes: number
  /** Default and maximum number of lines returned by one call. */
  readLimit: number
  /** Maximum characters returned for a single line. */
  maxLineLength: number
  /** Maximum bytes of line text returned by one call. */
  maxOutputBytes: number
  /** Maximum distinct PDF pages one `pages` selection may name. */
  pdfMaxPages: number
}

/** Canonical value of one successful call. */
export interface ReadDocumentOutcome {
  path: string
  format: DocumentFormat
  offset: number
  lines: WindowLine[]
  totalLines: number
  truncatedByBytes: boolean
  /** PDF facts; absent for other formats. */
  pdf?: PdfFacts
}

/** Validated arguments after defaulting. */
interface ReadInput {
  filePath: string
  offset: number
  limit: number
  pages?: number[]
}

const EXTENSION_LIST = DOCUMENT_EXTENSIONS.map(ext => `.${ext}`).join(', ')
const PDF_KINDS = ['text', 'scanned', 'image', 'mixed'] as const

function parsePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

/**
 * Validate the constraints the schema DSL does not express.
 * @param args - schema-validated raw arguments.
 * @param caps - the deployment line cap and PDF page cap.
 * @returns validated input with `offset` defaulted to 1 and `limit` to the cap.
 */
export function parseReadArgs(
  args: { file_path: string; offset?: number; limit?: number; pages?: string },
  caps: Pick<ReadDocumentCaps, 'readLimit' | 'pdfMaxPages'>,
): ReadInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  const offset = args.offset === undefined ? 1 : parsePositiveInteger(args.offset, 'offset')
  const limit = args.limit === undefined ? caps.readLimit : parsePositiveInteger(args.limit, 'limit')
  if (limit > caps.readLimit) throw new Error(`limit must be less than or equal to ${caps.readLimit}`)
  const pages = args.pages === undefined ? undefined : parsePages(args.pages, caps.pdfMaxPages)
  return { filePath: args.file_path, offset, limit, ...(pages === undefined ? {} : { pages }) }
}

const KIND_LABEL: Record<PdfFacts['kind'], string> = {
  text: 'text-based',
  scanned: 'scanned',
  image: 'image-only',
  mixed: 'mixed text and scanned pages',
}

/**
 * Model-facing text for one outcome: an envelope naming the path and format,
 * PDF facts when present, numbered lines, and a footer that says how to
 * continue.
 * @param outcome - the canonical value.
 * @returns the rendered text.
 */
export function formatReadOutput(outcome: ReadDocumentOutcome): string {
  const endLine = outcome.lines.at(-1)?.number ?? Math.max(0, outcome.offset - 1)
  let footer: string
  if (outcome.truncatedByBytes) {
    footer = `(Output capped. Showing lines ${outcome.offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
  } else if (endLine < outcome.totalLines) {
    footer = `(Showing lines ${outcome.offset}-${endLine} of ${outcome.totalLines}. Use offset=${endLine + 1} to continue.)`
  } else {
    footer = `(End of document - total ${outcome.totalLines} lines)`
  }
  const body = outcome.lines.length > 0
    ? `${outcome.lines.map(line => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}`
    : footer
  const head = [`<path>${outcome.path}</path>`, `<format>${outcome.format}</format>`]
  if (outcome.pdf !== undefined) {
    const { pageCount, kind, pages, pagesNeedingOcr, title } = outcome.pdf
    const shown = pages === undefined ? 'all pages' : `showing page${pages.length === 1 ? '' : 's'} ${formatPages(pages)}`
    head.push(`<pdf>${pageCount} page${pageCount === 1 ? '' : 's'}, ${KIND_LABEL[kind]}; ${shown}${title === undefined ? '' : `; title: ${title}`}</pdf>`)
    if (pagesNeedingOcr.length > 0) {
      head.push(`<warning>Page${pagesNeedingOcr.length === 1 ? '' : 's'} ${formatPages(pagesNeedingOcr)} contain${pagesNeedingOcr.length === 1 ? 's' : ''} no extractable text (scanned or image content); ${pagesNeedingOcr.length === 1 ? 'its' : 'their'} content is missing below and would need OCR.</warning>`)
    }
  }
  return `${head.join('\n')}\n<content>\n${body}\n</content>`
}

/** Model-facing message for one conversion failure. */
function describeFailure(displayPath: string, error: DocumentConversionError): string {
  switch (error.code) {
    case 'encrypted':
      return `cannot read "${displayPath}": the document is encrypted; supply a decrypted copy`
    case 'unsupported':
      return `cannot read "${displayPath}": ${error.message}`
    case 'empty':
      return `cannot read "${displayPath}": ${error.message}`
    case 'scanned':
      return `cannot read "${displayPath}": ${error.message}, which this tool does not perform`
    case 'pageRange':
      return `cannot read "${displayPath}": ${error.message}`
    case 'malformed':
    case 'missingPart':
      return `cannot read "${displayPath}": the file is damaged or incomplete (${error.message})`
    case 'resourceLimit':
      return `cannot read "${displayPath}": the document exceeds the converter's internal safety limits (${error.message})`
    case 'aborted':
      return `cannot read "${displayPath}": ${error.message}`
    case 'io':
    case 'unknown':
      return `cannot read "${displayPath}": ${error.message}`
  }
}

/**
 * Register the `read_document` tool and its system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it.
 * @param converterFor - the format router over the mounted engines.
 * @param caps - resolved deployment bounds.
 */
export function applyReadDocumentTool(
  ctx: Context,
  converterFor: (format: DocumentFormat) => DocumentConverter,
  caps: ReadDocumentCaps,
): void {
  ctx.systemPrompt.section({
    name: 'tool:read_document',
    order: 100,
    text: `Use the read_document tool — not read or shell commands — to inspect PDF, Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, and CSV files. It returns the document converted to line-numbered Markdown; use offset and limit to continue reading long documents. For a PDF, pass pages (for example "1-3,7") to read only those pages; page markers like <!-- Page 4 --> show where each page starts.`,
  })

  ctx.tools.register(defineTool({
    name: 'read_document',
    description: `Read a document file as Markdown: PDF, Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, and CSV files are converted to line-numbered Markdown text. Supported: ${EXTENSION_LIST}. Returns text only and writes no files. PDFs report page count, whether pages are scanned, and accept a pages selection; scanned or image-only pages are not OCRed. For plain text or source files use read; for images use read_image.`,
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the document, resolved by the filesystem backend; relative paths resolve against the session workspace.' },
      offset: { type: 'number', description: '1-based first line of the converted Markdown to return. Defaults to 1.' },
      limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${caps.readLimit}.` },
      pages: { type: 'string', description: `PDF only: 1-based pages to convert, as numbers and ranges like "1-3,7" (at most ${caps.pdfMaxPages} pages). Defaults to every page.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          format: { type: 'string', enum: [...DOCUMENT_FORMATS], required: true },
          offset: { type: 'integer', required: true },
          lines: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          totalLines: { type: 'integer', required: true },
          truncatedByBytes: { type: 'boolean', required: true },
          pdf: {
            type: 'object',
            additionalProperties: false,
            properties: {
              pageCount: { type: 'integer', required: true },
              kind: { type: 'string', enum: [...PDF_KINDS], required: true },
              pagesNeedingOcr: { type: 'array', required: true, items: { type: 'integer' } },
              pages: { type: 'array', items: { type: 'integer' } },
              title: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatReadOutput(value as ReadDocumentOutcome) }],
    },
    // Read-only: safe beside other tool calls in the same step.
    isConcurrencySafe: () => true,
    async execute(args, exec: ToolExecution): Promise<ReadDocumentOutcome> {
      const input = parseReadArgs(args, caps)
      const format = formatOf(input.filePath)
      if (format === undefined) {
        throw new Error(
          `cannot read "${input.filePath}": unsupported extension. Supported: ${EXTENSION_LIST}. For plain text or source files use the read tool.`,
        )
      }
      if (input.pages !== undefined && format !== 'pdf') {
        throw new Error(`pages applies to PDF files only; "${input.filePath}" is ${format}`)
      }

      // Per-session workspace, like the shipped filesystem tools; a non-agent
      // caller falls back to the provider default.
      const cwd = exec.agent?.session.header.cwd
      const target = await ctx.fs.resolve(input.filePath, {
        ...cwd === undefined ? {} : { cwd },
        signal: exec.signal,
      })
      const info = await ctx.fs.stat(target, exec.signal)
      if (info === undefined) throw new Error(`cannot read "${target.displayPath}": not found`)
      if (info.type !== 'file') throw new Error(`cannot read "${target.displayPath}": not a regular file`)

      // The provider enforces the input cap, so an oversized file never buffers.
      const bytes = await ctx.fs.readBytes(target, exec.signal, caps.maxInputBytes)

      let converted
      try {
        converted = await converterFor(format).convert({
          bytes,
          format,
          signal: exec.signal,
          ...(input.pages === undefined ? {} : { pages: input.pages }),
        })
      } catch (error: unknown) {
        if (error instanceof DocumentConversionError) throw new Error(describeFailure(target.displayPath, error))
        throw error
      }

      const window = windowLines(converted.markdown, {
        offset: input.offset,
        limit: input.limit,
        maxLineLength: caps.maxLineLength,
        maxBytes: caps.maxOutputBytes,
      })
      return {
        path: target.displayPath,
        format,
        offset: input.offset,
        lines: window.lines,
        totalLines: window.totalLines,
        truncatedByBytes: window.truncatedByBytes,
        ...(converted.pdf === undefined ? {} : { pdf: converted.pdf }),
      }
    },
    // Pure display: a generic read-kind card titled by the file, with the
    // requested pages or line window when the raw args carry one, and a
    // follow-along location.
    presentCall(args): GenericCallView {
      const { offset, limit, pages } = args
      const window = pages !== undefined && pages.length > 0
        ? ` (pages ${pages})`
        : limit !== undefined && limit > 0
          ? ` (lines ${offset ?? 1} - ${(offset ?? 1) + limit - 1})`
          : offset !== undefined ? ` (from line ${offset})` : ''
      return {
        card: 'generic',
        title: `Read ${args.file_path} as Markdown${window}`,
        kind: 'read',
        locations: [{ path: args.file_path }],
      }
    },
  }))
}
