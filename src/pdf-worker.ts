/**
 * Worker-thread entry for PDF conversion. Runs `@firecrawl/pdf-inspector`'s
 * WASM build, whose `processPdf` is synchronous, off the main event loop;
 * the parent terminates the worker to cancel. This module is executed by
 * Node directly (never bundled into the plugin entry), so it stays free of
 * TypeScript-only runtime syntax and imports nothing from the plugin.
 * @module @jiaoqsh/dsh-document/pdf-worker
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'
import { initSync, processPdf } from '@firecrawl/pdf-inspector-wasm'
import type { MarkdownProfile } from '@firecrawl/pdf-inspector-wasm'

/** What the parent posts as `workerData`. */
export interface PdfWorkerRequest {
  bytes: Uint8Array
  /** 1-based pages to convert; absent means all. */
  pages?: number[]
  profile: MarkdownProfile
}

/** The engine facts the parent needs; everything else stays in the worker. */
export interface PdfWorkerResult {
  markdown: string
  pdfType: 'TextBased' | 'Scanned' | 'ImageBased' | 'Mixed'
  pageCount: number
  /** 1-based. */
  pagesNeedingOcr: number[]
  title?: string
}

/** Worker → parent message. */
export type PdfWorkerReply =
  | { ok: true; result: PdfWorkerResult }
  | { ok: false; message: string }

const require = createRequire(import.meta.url)

function run(request: PdfWorkerRequest): PdfWorkerResult {
  initSync({
    module: readFileSync(require.resolve('@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm')),
  })
  const result = processPdf(new Uint8Array(request.bytes), {
    profile: request.profile,
    includePageMarkers: true,
    includeImages: false,
    ...(request.pages === undefined ? {} : { pages: request.pages }),
  })
  return {
    markdown: result.markdown ?? '',
    pdfType: result.pdfType,
    pageCount: result.pageCount,
    pagesNeedingOcr: result.pagesNeedingOcr,
    ...(result.title === undefined ? {} : { title: result.title }),
  }
}

if (parentPort !== null) {
  let reply: PdfWorkerReply
  try {
    reply = { ok: true, result: run(workerData as PdfWorkerRequest) }
  } catch (error: unknown) {
    reply = { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  parentPort.postMessage(reply)
}
