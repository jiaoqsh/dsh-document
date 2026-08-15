/**
 * DeepSeek Harness plugin: the `read_document` tool. Word, PowerPoint,
 * Excel, OpenDocument, RTF, EPUB, CSV, and PDF files are read through the
 * `ctx.fs` seam, converted locally, and returned to the model as
 * line-numbered Markdown. Office formats convert with `@firecrawl/anydoc`;
 * PDFs convert with `@firecrawl/pdf-inspector` in a worker thread, with page
 * selection and scanned-page facts.
 * @module @jiaoqsh/dsh-document
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { anydocConverter, routeConverters } from './converter.ts'
import { pdfInspectorConverter } from './pdf-inspector.ts'
import { applyReadDocumentTool } from './tool.ts'

export {
  DOCUMENT_EXTENSIONS,
  DOCUMENT_FORMATS,
  DocumentConversionError,
  anydocConverter,
  formatOf,
  routeConverters,
} from './converter.ts'
export type {
  ConversionErrorCode,
  ConvertRequest,
  ConvertResult,
  DocumentConverter,
  DocumentFormat,
  PdfFacts,
  PdfKind,
} from './converter.ts'
export { pdfInspectorConverter } from './pdf-inspector.ts'
export type { PdfInspectorOptions } from './pdf-inspector.ts'
export type { ReadDocumentCaps, ReadDocumentOutcome } from './tool.ts'

export const name = 'document-tools'
export const inject = ['tools', 'fs', 'systemPrompt']

/** Default inclusive byte cap on a source document. */
export const DEFAULT_MAX_INPUT_BYTES = 50 * 1024 * 1024
/** Default and maximum lines per call. */
export const DEFAULT_READ_LIMIT = 2000
/** Default per-line character cap. */
export const DEFAULT_MAX_LINE_LENGTH = 2000
/** Default byte cap on returned line text per call. */
export const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024
/** Default cap on distinct pages one PDF `pages` selection may name. */
export const DEFAULT_PDF_MAX_PAGES = 100

/** PDF Markdown profiles the engine offers. */
export type PdfProfile = 'fidelity' | 'compact'

/**
 * Deployment-owned bounds and choices. Every field is optional on the input
 * side because the schema fills defaults; `apply` receives the resolved record.
 */
export interface Config {
  /** Inclusive byte cap on the source file; larger files are refused before conversion. */
  maxInputBytes?: number
  /** Default and maximum number of Markdown lines returned by one call. */
  readLimit?: number
  /** Maximum characters returned for a single line; overflow is cut with a marker. */
  maxLineLength?: number
  /** Maximum bytes of line text returned by one call. */
  maxOutputBytes?: number
  /** Maximum distinct pages one PDF `pages` selection may name. */
  pdfMaxPages?: number
  /** PDF Markdown profile: `fidelity` keeps source structure, `compact` spends fewer tokens. */
  pdfProfile?: PdfProfile
}

export const Config: Schema<Config> = Schema.object({
  maxInputBytes: Schema.number().default(DEFAULT_MAX_INPUT_BYTES),
  readLimit: Schema.number().default(DEFAULT_READ_LIMIT),
  maxLineLength: Schema.number().default(DEFAULT_MAX_LINE_LENGTH),
  maxOutputBytes: Schema.number().default(DEFAULT_MAX_OUTPUT_BYTES),
  pdfMaxPages: Schema.number().default(DEFAULT_PDF_MAX_PAGES),
  pdfProfile: Schema.union(['fidelity', 'compact']).default('fidelity'),
})

type ResolvedConfig = Required<Config>

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`document-tools: ${name} must be a positive integer`)
  }
}

/**
 * Register `read_document` over the anydoc and pdf-inspector engines.
 * @param ctx - context carrying the tool registry, filesystem seam, and system-prompt registry.
 * @param rawConfig - schema-validated bounds after defaulting.
 */
export function apply(ctx: Context, rawConfig: Config): void {
  const config = rawConfig as ResolvedConfig
  assertPositiveInteger('maxInputBytes', config.maxInputBytes)
  assertPositiveInteger('readLimit', config.readLimit)
  assertPositiveInteger('maxLineLength', config.maxLineLength)
  assertPositiveInteger('maxOutputBytes', config.maxOutputBytes)
  assertPositiveInteger('pdfMaxPages', config.pdfMaxPages)
  const converterFor = routeConverters([
    pdfInspectorConverter({ profile: config.pdfProfile }),
    anydocConverter(),
  ])
  applyReadDocumentTool(ctx, converterFor, {
    maxInputBytes: config.maxInputBytes,
    readLimit: config.readLimit,
    maxLineLength: config.maxLineLength,
    maxOutputBytes: config.maxOutputBytes,
    pdfMaxPages: config.pdfMaxPages,
  })
}
