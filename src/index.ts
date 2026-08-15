/**
 * DeepSeek Harness plugin: the `convert_document` tool. Word, PowerPoint,
 * Excel, OpenDocument, RTF, EPUB, CSV, and PDF files become line-numbered
 * Markdown for the model, read through the `ctx.fs` seam and converted
 * locally by `@firecrawl/anydoc`.
 * @module @jiaoqsh/dsh-document
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { anydocConverter } from './converter.ts'
import { applyConvertDocumentTool } from './tool.ts'

export {
  DOCUMENT_EXTENSIONS,
  DOCUMENT_FORMATS,
  DocumentConversionError,
  anydocConverter,
} from './converter.ts'
export type { ConversionErrorCode, DocumentConverter, DocumentFormat } from './converter.ts'
export type { ConvertDocumentCaps, ConvertDocumentOutcome } from './tool.ts'

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

/**
 * Deployment-owned bounds. Every field is optional on the input side because
 * the schema fills defaults; `apply` receives the resolved record.
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
}

export const Config: Schema<Config> = Schema.object({
  maxInputBytes: Schema.number().default(DEFAULT_MAX_INPUT_BYTES),
  readLimit: Schema.number().default(DEFAULT_READ_LIMIT),
  maxLineLength: Schema.number().default(DEFAULT_MAX_LINE_LENGTH),
  maxOutputBytes: Schema.number().default(DEFAULT_MAX_OUTPUT_BYTES),
})

type ResolvedConfig = Required<Config>

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`document-tools: ${name} must be a positive integer`)
  }
}

/**
 * Register `convert_document` over the anydoc engine.
 * @param ctx - context carrying the tool registry, filesystem seam, and system-prompt registry.
 * @param rawConfig - schema-validated bounds after defaulting.
 */
export function apply(ctx: Context, rawConfig: Config): void {
  const config = rawConfig as ResolvedConfig
  assertPositiveInteger('maxInputBytes', config.maxInputBytes)
  assertPositiveInteger('readLimit', config.readLimit)
  assertPositiveInteger('maxLineLength', config.maxLineLength)
  assertPositiveInteger('maxOutputBytes', config.maxOutputBytes)
  applyConvertDocumentTool(ctx, anydocConverter(), {
    maxInputBytes: config.maxInputBytes,
    readLimit: config.readLimit,
    maxLineLength: config.maxLineLength,
    maxOutputBytes: config.maxOutputBytes,
  })
}
