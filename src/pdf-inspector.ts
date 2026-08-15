/**
 * The pdf-inspector engine: PDF → Markdown with page selection, page markers,
 * and scanned-page facts. Each conversion runs in a fresh worker thread so a
 * large document never blocks the harness event loop, and cancellation
 * terminates the worker.
 * @module @jiaoqsh/dsh-document/pdf-inspector
 */

import { Worker } from 'node:worker_threads'
import type { MarkdownProfile } from '@firecrawl/pdf-inspector-wasm'
import {
  DocumentConversionError,
  type ConvertRequest,
  type ConvertResult,
  type DocumentConverter,
  type PdfKind,
} from './converter.ts'
import type { PdfWorkerReply, PdfWorkerRequest, PdfWorkerResult } from './pdf-worker.ts'

/** Deployment choices for the PDF engine. */
export interface PdfInspectorOptions {
  /** `fidelity` keeps source structure; `compact` spends fewer tokens. */
  profile: MarkdownProfile
}

const KIND: Record<PdfWorkerResult['pdfType'], PdfKind> = {
  TextBased: 'text',
  Scanned: 'scanned',
  ImageBased: 'image',
  Mixed: 'mixed',
}

// The worker file sits beside this module in both the source tree and the
// built lib/. A computed name keeps bundlers from rewriting the URL as an
// asset. Source mode exists only for tests: Node then strips the worker's
// types itself, and the flag makes that hold on every supported Node (it is
// the default from 22.18 and merely redundant there).
const WORKER_IS_SOURCE = import.meta.url.endsWith('.ts')
const WORKER_URL = new URL(WORKER_IS_SOURCE ? 'pdf-worker.ts' : 'pdf-worker.js', import.meta.url)
const WORKER_EXEC_ARGV = WORKER_IS_SOURCE
  ? [...process.execArgv, '--experimental-strip-types', '--no-warnings']
  : undefined

/** Classify an engine failure message; the engine reports plain strings, not codes. */
function engineError(message: string): DocumentConversionError {
  const text = message.replace(/^process PDF: /u, '')
  const lower = text.toLowerCase()
  if (lower.includes('not a pdf') || lower.includes('malformed') || lower.includes('invalid')) {
    return new DocumentConversionError(text, 'malformed')
  }
  if (lower.includes('encrypt') || lower.includes('password')) {
    return new DocumentConversionError(text, 'encrypted')
  }
  return new DocumentConversionError(text, 'unknown')
}

/**
 * Run one conversion in a worker and settle with its reply.
 * @param request - bytes, pages, and profile for the worker.
 * @param signal - terminates the worker when it fires.
 * @returns the worker's facts and Markdown.
 */
export function runPdfWorker(request: PdfWorkerRequest, signal: AbortSignal): Promise<PdfWorkerResult> {
  return new Promise<PdfWorkerResult>((resolve, reject) => {
    const worker = new Worker(WORKER_URL, {
      workerData: request,
      ...(WORKER_EXEC_ARGV === undefined ? {} : { execArgv: WORKER_EXEC_ARGV }),
    })
    let settled = false
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      // Terminate is idempotent; after a normal reply it only reclaims the thread.
      void worker.terminate()
      outcome()
    }
    const onAbort = (): void => settle(() => reject(new DocumentConversionError('the conversion was cancelled', 'aborted')))
    signal.addEventListener('abort', onAbort, { once: true })
    worker.once('message', (reply: PdfWorkerReply) => settle(() => {
      if (reply.ok) resolve(reply.result)
      else reject(engineError(reply.message))
    }))
    worker.once('error', (error: Error) => settle(() => reject(new DocumentConversionError(error.message, 'unknown'))))
    worker.once('exit', (code: number) => settle(() => reject(
      new DocumentConversionError(`the PDF worker exited with code ${code} before replying`, 'unknown'),
    )))
  })
}

function formatPages(pages: readonly number[]): string {
  const sorted = [...pages].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length;) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j += 1
    parts.push(j === i ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`)
    i = j + 1
  }
  return parts.join(', ')
}

/**
 * Build the PDF engine.
 * @param options - deployment choices.
 * @returns a converter that handles only `pdf`.
 */
export function pdfInspectorConverter(options: PdfInspectorOptions): DocumentConverter {
  return {
    name: 'pdf-inspector',
    formats: ['pdf'],
    async convert({ bytes, pages, signal }: ConvertRequest): Promise<ConvertResult> {
      if (signal.aborted) throw new DocumentConversionError('the conversion was cancelled', 'aborted')
      const raw = await runPdfWorker({
        bytes,
        profile: options.profile,
        ...(pages === undefined ? {} : { pages: [...pages] }),
      }, signal)

      if (pages !== undefined) {
        const beyond = pages.filter(page => page > raw.pageCount)
        if (beyond.length > 0) {
          throw new DocumentConversionError(
            `the document has ${raw.pageCount} page${raw.pageCount === 1 ? '' : 's'}; requested page${beyond.length === 1 ? '' : 's'} ${formatPages(beyond)} ${beyond.length === 1 ? 'does' : 'do'} not exist`,
            'pageRange',
          )
        }
      }

      const kind = KIND[raw.pdfType]
      if (raw.markdown.trim().length === 0) {
        const plural = pages === undefined ? raw.pageCount !== 1 : pages.length !== 1
        const scope = pages === undefined
          ? `all ${raw.pageCount} page${plural ? 's' : ''}`
          : `the requested page${plural ? 's' : ''} (${formatPages(pages)})`
        const verb = plural ? 'contain' : 'contains'
        if (kind === 'scanned' || kind === 'image') {
          throw new DocumentConversionError(
            `${scope} ${verb} no extractable text: this is ${kind === 'image' ? 'an image-only' : 'a scanned'} PDF and needs OCR`,
            'scanned',
          )
        }
        if (raw.pagesNeedingOcr.length > 0) {
          throw new DocumentConversionError(
            `${scope} ${verb} no extractable text (pages needing OCR: ${formatPages(raw.pagesNeedingOcr)})`,
            'scanned',
          )
        }
        throw new DocumentConversionError('the document contains no extractable text', 'empty')
      }

      return {
        markdown: raw.markdown,
        pdf: {
          pageCount: raw.pageCount,
          kind,
          pagesNeedingOcr: raw.pagesNeedingOcr,
          ...(pages === undefined ? {} : { pages: [...pages] }),
          ...(raw.title === undefined ? {} : { title: raw.title }),
        },
      }
    },
  }
}

export { formatPages }
