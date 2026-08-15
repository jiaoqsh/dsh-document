/**
 * The model-facing `convert_document` tool: resolve a path through `ctx.fs`,
 * read the bytes under the input cap, convert to Markdown, and return one
 * line-numbered window.
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
  type DocumentConverter,
  type DocumentFormat,
} from './converter.ts'
import { windowLines, type WindowLine } from './window.ts'

/** Deployment bounds after defaulting (see `Config` in index.ts). */
export interface ConvertDocumentCaps {
  /** Inclusive byte cap on the source file; larger files are refused before conversion. */
  maxInputBytes: number
  /** Default and maximum number of lines returned by one call. */
  readLimit: number
  /** Maximum characters returned for a single line. */
  maxLineLength: number
  /** Maximum bytes of line text returned by one call. */
  maxOutputBytes: number
}

/** Canonical value of one successful call. */
export interface ConvertDocumentOutcome {
  path: string
  format: DocumentFormat
  offset: number
  lines: WindowLine[]
  totalLines: number
  truncatedByBytes: boolean
}

/** Validated arguments after defaulting. */
interface ConvertInput {
  filePath: string
  offset: number
  limit: number
}

const EXTENSION_LIST = DOCUMENT_EXTENSIONS.map(ext => `.${ext}`).join(', ')

function parsePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

/**
 * Validate the constraints the schema DSL does not express.
 * @param args - schema-validated raw arguments.
 * @param maxLimit - the deployment line cap: both the default `limit` and the largest accepted.
 * @returns validated input with `offset` defaulted to 1 and `limit` to `maxLimit`.
 */
export function parseConvertArgs(
  args: { file_path: string; offset?: number; limit?: number },
  maxLimit: number,
): ConvertInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  const offset = args.offset === undefined ? 1 : parsePositiveInteger(args.offset, 'offset')
  const limit = args.limit === undefined ? maxLimit : parsePositiveInteger(args.limit, 'limit')
  if (limit > maxLimit) throw new Error(`limit must be less than or equal to ${maxLimit}`)
  return { filePath: args.file_path, offset, limit }
}

/**
 * Model-facing text for one outcome: an envelope naming the path and format,
 * numbered lines, and a footer that says how to continue.
 * @param outcome - the canonical value.
 * @returns the rendered text.
 */
export function formatConvertOutput(outcome: ConvertDocumentOutcome): string {
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
  return `<path>${outcome.path}</path>\n<format>${outcome.format}</format>\n<content>\n${body}\n</content>`
}

/** Model-facing message for one conversion failure. */
function describeFailure(displayPath: string, error: DocumentConversionError): string {
  switch (error.code) {
    case 'encrypted':
      return `cannot convert "${displayPath}": the document is encrypted; supply a decrypted copy`
    case 'unsupported':
      return `cannot convert "${displayPath}": ${error.message}. If this is a scanned or image-only PDF, its pages need OCR, which this tool does not perform`
    case 'empty':
      return `cannot convert "${displayPath}": ${error.message}. A scanned or image-only document needs OCR, which this tool does not perform`
    case 'malformed':
    case 'missingPart':
      return `cannot convert "${displayPath}": the file is damaged or incomplete (${error.message})`
    case 'resourceLimit':
      return `cannot convert "${displayPath}": the document exceeds the converter's internal safety limits (${error.message})`
    case 'io':
    case 'unknown':
      return `cannot convert "${displayPath}": ${error.message}`
  }
}

/**
 * Register the `convert_document` tool and its system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it.
 * @param converter - the engine that maps extensions to formats and converts bytes.
 * @param caps - resolved deployment bounds.
 */
export function applyConvertDocumentTool(
  ctx: Context,
  converter: DocumentConverter,
  caps: ConvertDocumentCaps,
): void {
  ctx.systemPrompt.section({
    name: 'tool:convert_document',
    order: 100,
    text: `Use the convert_document tool — not read or shell commands — to inspect PDF, Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, and CSV files. It returns the document as line-numbered Markdown; use offset and limit to continue reading long documents.`,
  })

  ctx.tools.register(defineTool({
    name: 'convert_document',
    description: `Convert a document file to Markdown and return it as line-numbered text. Supported: ${EXTENSION_LIST}. Returns text only and writes no files. Scanned or image-only PDFs are not OCRed. For plain text or source files use read; for images use read_image.`,
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the document, resolved by the filesystem backend; relative paths resolve against the session workspace.' },
      offset: { type: 'number', description: '1-based first line of the converted Markdown to return. Defaults to 1.' },
      limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${caps.readLimit}.` },
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
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatConvertOutput(value as ConvertDocumentOutcome) }],
    },
    // Read-only: safe beside other tool calls in the same step.
    isConcurrencySafe: () => true,
    async execute(args, exec: ToolExecution): Promise<ConvertDocumentOutcome> {
      const input = parseConvertArgs(args, caps.readLimit)
      const format = converter.formatOf(input.filePath)
      if (format === undefined) {
        throw new Error(
          `cannot convert "${input.filePath}": unsupported extension. Supported: ${EXTENSION_LIST}. For plain text or source files use the read tool.`,
        )
      }

      // Per-session workspace, like the shipped filesystem tools; a non-agent
      // caller falls back to the provider default.
      const cwd = exec.agent?.session.header.cwd
      const target = await ctx.fs.resolve(input.filePath, {
        ...cwd === undefined ? {} : { cwd },
        signal: exec.signal,
      })
      const info = await ctx.fs.stat(target, exec.signal)
      if (info === undefined) throw new Error(`cannot convert "${target.displayPath}": not found`)
      if (info.type !== 'file') throw new Error(`cannot convert "${target.displayPath}": not a regular file`)

      // The provider enforces the input cap, so an oversized file never buffers.
      const bytes = await ctx.fs.readBytes(target, exec.signal, caps.maxInputBytes)
      // Conversion runs to completion once started; honor cancellation before it.
      exec.signal.throwIfAborted()

      let markdown: string
      try {
        markdown = await converter.toMarkdown(bytes, format)
      } catch (error: unknown) {
        if (error instanceof DocumentConversionError) throw new Error(describeFailure(target.displayPath, error))
        throw error
      }

      const window = windowLines(markdown, {
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
      }
    },
    // Pure display: a generic read-kind card titled by the file, with the
    // requested window when the raw args carry one, and a follow-along location.
    presentCall(args): GenericCallView {
      const { offset, limit } = args
      const window = limit !== undefined && limit > 0
        ? ` (lines ${offset ?? 1} - ${(offset ?? 1) + limit - 1})`
        : offset !== undefined ? ` (from line ${offset})` : ''
      return {
        card: 'generic',
        title: `Convert ${args.file_path} to Markdown${window}`,
        kind: 'read',
        locations: [{ path: args.file_path }],
      }
    },
  }))
}
