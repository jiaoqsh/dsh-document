/**
 * Real-composition tests: a real Cordis Context with the published tool
 * registry, system-prompt registry, and local filesystem provider; only the
 * model is absent. Calls go through `ctx.tools.execute`, the entry the agent
 * loop uses.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as DocumentTools from '../src/index.ts'
import { DocumentConversionError, anydocConverter, formatOf, routeConverters } from '../src/converter.ts'
import { parsePages } from '../src/pages.ts'
import { formatPages, pdfInspectorConverter } from '../src/pdf-inspector.ts'
import { formatReadOutput, parseReadArgs } from '../src/tool.ts'
import { splitLines, windowLines } from '../src/window.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A fresh workspace seeded with every fixture. */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-document-'))
  roots.push(root)
  cpSync(FIXTURES, root, { recursive: true })
  return root
}

async function mount(cwd: string, config?: DocumentTools.Config) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd })
  const fiber = await ctx.plugin(DocumentTools, config)
  return { ctx, fiber }
}

let calls = 0
function call(ctx: Context, args: unknown, agentCwd?: string) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`call-${++calls}`),
    name: 'read_document',
    arguments: args,
    ...agentCwd === undefined ? {} : { agent: { session: { header: { cwd: agentCwd } } } as never },
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('windowLines', () => {
  const bounds = { maxLineLength: 100, maxBytes: 10_000 }

  it('splits lines like a text file: trailing newline opens no line, empty text has none', () => {
    expect(splitLines('')).toEqual([])
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\r\nb')).toEqual(['a', 'b'])
  })

  it('pages by offset and limit and reports the exact total', () => {
    const doc = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
    expect(windowLines(doc, { offset: 4, limit: 3, ...bounds })).toEqual({
      lines: [{ number: 4, text: 'line 4' }, { number: 5, text: 'line 5' }, { number: 6, text: 'line 6' }],
      totalLines: 10,
      truncatedByBytes: false,
    })
    expect(windowLines(doc, { offset: 11, limit: 3, ...bounds }).lines).toEqual([])
  })

  it('cuts long lines with a marker and stops at the byte cap', () => {
    const long = 'x'.repeat(150)
    const cut = windowLines(long, { offset: 1, limit: 1, maxLineLength: 100, maxBytes: 10_000 })
    expect(cut.lines[0]!.text).toBe(`${'x'.repeat(100)}… [line truncated]`)
    const capped = windowLines('aaaa\nbbbb\ncccc', { offset: 1, limit: 3, maxLineLength: 100, maxBytes: 9 })
    expect(capped.lines.map(l => l.text)).toEqual(['aaaa', 'bbbb'])
    expect(capped.truncatedByBytes).toBe(true)
  })

  it('cuts an oversized first line on a character boundary so the caller makes progress', () => {
    const result = windowLines('日本語テキスト', { offset: 1, limit: 1, maxLineLength: 100, maxBytes: 7 })
    expect(result.lines[0]!.text).toBe('日本')
    expect(result.truncatedByBytes).toBe(true)
  })
})

const liveSignal = () => new AbortController().signal
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)))

describe('format routing', () => {
  it('maps extensions case-insensitively and rejects unknown ones', () => {
    expect(formatOf('/tmp/Report.PDF')).toBe('pdf')
    expect(formatOf('slides.pptm')).toBe('pptx')
    expect(formatOf('legacy.xls')).toBe('xlsx')
    expect(formatOf('notes.txt')).toBeUndefined()
    expect(formatOf('archive.tar.gz')).toBeUndefined()
  })

  it('picks the first engine listing a format and fails loud otherwise', () => {
    const pdf = pdfInspectorConverter({ profile: 'fidelity' })
    const any = anydocConverter()
    const route = routeConverters([pdf, any])
    expect(route('pdf')).toBe(pdf)
    expect(route('docx')).toBe(any)
    expect(() => routeConverters([pdf])('docx')).toThrow('no engine converts docx')
  })
})

describe('anydoc engine', () => {
  const converter = anydocConverter()

  it('reports engine failures with a stable code', async () => {
    await expect(converter.convert({ bytes: new Uint8Array([1, 2, 3]), format: 'docx', signal: liveSignal() }))
      .rejects.toMatchObject({ name: 'DocumentConversionError', code: expect.stringMatching(/malformed|missingPart|unsupported/) })
    await expect(converter.convert({ bytes: new Uint8Array(), format: 'csv', signal: liveSignal() }))
      .rejects.toMatchObject({ code: 'empty' })
  })
})

describe('pdf-inspector engine (worker thread)', () => {
  const converter = pdfInspectorConverter({ profile: 'fidelity' })

  it('converts every page with markers and reports page facts', async () => {
    const result = await converter.convert({ bytes: fixture('pages.pdf'), format: 'pdf', signal: liveSignal() })
    expect(result.pdf).toEqual({ pageCount: 5, kind: 'text', pagesNeedingOcr: [] })
    expect(result.markdown.startsWith('<!-- Page 1 -->')).toBe(true)
    expect(result.markdown.match(/<!-- Page \d+ -->/g)).toHaveLength(5)
  })

  it('converts only the selected pages', async () => {
    const result = await converter.convert({ bytes: fixture('pages.pdf'), format: 'pdf', pages: [2, 4], signal: liveSignal() })
    expect(result.pdf?.pages).toEqual([2, 4])
    expect(result.markdown.match(/<!-- Page \d+ -->/g)).toEqual(['<!-- Page 2 -->', '<!-- Page 4 -->'])
    expect(result.markdown).toContain('Line 63:')
    expect(result.markdown).not.toContain('Line 1:')
  })

  it('names pages beyond the last page instead of returning nothing', async () => {
    await expect(converter.convert({ bytes: fixture('pages.pdf'), format: 'pdf', pages: [4, 9, 10], signal: liveSignal() }))
      .rejects.toMatchObject({ code: 'pageRange', message: 'the document has 5 pages; requested pages 9-10 do not exist' })
  })

  it('classifies an image-only PDF as needing OCR', async () => {
    await expect(converter.convert({ bytes: fixture('scan.pdf'), format: 'pdf', signal: liveSignal() }))
      .rejects.toMatchObject({ code: 'scanned', message: 'all 1 page contains no extractable text: this is a scanned PDF and needs OCR' })
  })

  it('maps engine messages to codes', async () => {
    await expect(converter.convert({ bytes: fixture('broken.docx'), format: 'pdf', signal: liveSignal() }))
      .rejects.toMatchObject({ code: 'malformed', message: expect.stringMatching(/^Not a PDF/) })
  })

  it('terminates the worker when the signal fires', async () => {
    const controller = new AbortController()
    const pending = converter.convert({ bytes: fixture('pages.pdf'), format: 'pdf', signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
    const preAborted = new AbortController()
    preAborted.abort()
    await expect(converter.convert({ bytes: fixture('pages.pdf'), format: 'pdf', signal: preAborted.signal }))
      .rejects.toBeInstanceOf(DocumentConversionError)
  })
})

describe('parsePages / formatPages', () => {
  it('parses numbers and ranges into a sorted unique list', () => {
    expect(parsePages('3, 1-2, 2', 100)).toEqual([1, 2, 3])
    expect(formatPages([1, 2, 3, 7, 10, 11])).toBe('1-3, 7, 10-11')
  })

  it('rejects malformed, inverted, empty, and oversized selections', () => {
    expect(() => parsePages('a', 100)).toThrow('got "a"')
    expect(() => parsePages('5-2', 100)).toThrow('invalid range "5-2"')
    expect(() => parsePages('0', 100)).toThrow('invalid range "0"')
    expect(() => parsePages('1-200', 100)).toThrow('more than 100 pages')
    expect(() => parsePages(' ', 100)).toThrow()
  })
})

describe('read_document plugin', () => {
  it('registers the tool schema and its prompt guidance', async () => {
    const { ctx } = await mount(workspace())
    expect(ctx.tools.schemas().map(s => s.name)).toContain('read_document')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('Use the read_document tool')
  })

  it.each(['sample.docx', 'sample.rtf'])('converts %s to numbered Markdown lines', async (file) => {
    const root = workspace()
    const { ctx } = await mount(root)
    const result = await call(ctx, { file_path: file, limit: 3 })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe([
      `<path>${join(root, file)}</path>`,
      `<format>${file.split('.').pop()}</format>`,
      '<content>',
      '1: Sample Report',
      '2: ',
      '3: Revenue grew 12% year over year. Key drivers:',
      '',
      '(Showing lines 1-3 of 87. Use offset=4 to continue.)',
      '</content>',
    ].join('\n'))
  })

  it('renders CSV as a Markdown table', async () => {
    const { ctx } = await mount(workspace())
    const result = await call(ctx, { file_path: 'sample.csv' })
    expect(text(result)).toContain('1: | name | score | city |')
    expect(text(result)).toContain('(End of document - total 4 lines)')
  })

  it('pages with offset/limit and caps a runaway PDF line by maxLineLength', async () => {
    const { ctx } = await mount(workspace(), { maxLineLength: 80 })
    const page2 = await call(ctx, { file_path: 'sample.docx', offset: 9, limit: 2 })
    expect(text(page2)).toContain('9: Paragraph 1: the quick brown fox')
    expect(text(page2)).toContain('(Showing lines 9-10 of 87. Use offset=11 to continue.)')
    const pdf = await call(ctx, { file_path: 'sample.pdf' })
    expect(pdf.isError).toBe(false)
    expect(text(pdf)).toContain('<format>pdf</format>\n<pdf>1 page, text-based; all pages</pdf>')
    expect(text(pdf)).toContain('… [line truncated]')
  })

  it('reads selected PDF pages with markers and reports the page facts', async () => {
    const { ctx } = await mount(workspace())
    const result = await call(ctx, { file_path: 'pages.pdf', pages: '2,4', limit: 3 })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('<pdf>5 pages, text-based; showing pages 2, 4</pdf>\n<content>\n1: <!-- Page 2 -->')
    expect(text(result)).toContain('(Showing lines 1-3 of ')
    const beyond = await call(ctx, { file_path: 'pages.pdf', pages: '6' })
    expect(text(beyond)).toContain('the document has 5 pages; requested page 6 does not exist')
    const nonPdf = await call(ctx, { file_path: 'sample.docx', pages: '1' })
    expect(text(nonPdf)).toContain('pages applies to PDF files only')
    const bad = await call(ctx, { file_path: 'pages.pdf', pages: 'ii' })
    expect(text(bad)).toContain('pages must be comma-separated page numbers or ranges')
  })

  it('tells the model a scanned PDF needs OCR', async () => {
    const { ctx } = await mount(workspace())
    const result = await call(ctx, { file_path: 'scan.pdf' })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Error: cannot read "' + join(roots.at(-1)!, 'scan.pdf') + '": all 1 page contains no extractable text: this is a scanned PDF and needs OCR, which this tool does not perform')
  })

  it('resolves relative paths against the calling session workspace', async () => {
    const serverCwd = mkdtempSync(join(tmpdir(), 'dsh-document-server-'))
    roots.push(serverCwd)
    const sessionCwd = workspace()
    const { ctx } = await mount(serverCwd)
    expect(text(await call(ctx, { file_path: 'sample.rtf' }))).toContain('not found')
    expect((await call(ctx, { file_path: 'sample.rtf' }, sessionCwd)).isError).toBe(false)
  })

  it('points the model at read for unsupported extensions and rejects bad windows', async () => {
    const { ctx } = await mount(workspace())
    const txt = await call(ctx, { file_path: 'notes.txt' })
    expect(txt.isError).toBe(true)
    expect(text(txt)).toContain('unsupported extension')
    expect(text(txt)).toContain('use the read tool')
    expect(text(await call(ctx, { file_path: 'sample.docx', limit: 5000 }))).toContain('limit must be less than or equal to 2000')
    expect(text(await call(ctx, { file_path: 'sample.docx', offset: 0 }))).toContain('offset must be a positive integer')
    expect(text(await call(ctx, { file_path: '.' }))).toContain('unsupported extension')
  })

  it('explains engine failures in model terms', async () => {
    const { ctx } = await mount(workspace())
    const broken = await call(ctx, { file_path: 'broken.docx' })
    expect(broken.isError).toBe(true)
    expect(text(broken)).toMatch(/damaged or incomplete \(missing required part/)
    const empty = await call(ctx, { file_path: 'empty.csv' })
    expect(text(empty)).toContain('no extractable text')
  })

  it('lets the filesystem provider refuse files over maxInputBytes', async () => {
    const { ctx } = await mount(workspace(), { maxInputBytes: 1024 })
    const result = await call(ctx, { file_path: 'sample.docx' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/exceeds the 1024-byte limit/)
  })

  it('reports non-regular and missing targets', async () => {
    const root = workspace()
    writeFileSync(join(root, 'dir.pdf'), '')
    rmSync(join(root, 'dir.pdf'))
    const { ctx } = await mount(root)
    expect(text(await call(ctx, { file_path: 'missing.pdf' }))).toContain('not found')
  })

  it('fails loud on invalid configuration', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: workspace() })
    await expect(ctx.plugin(DocumentTools, { readLimit: 0 })).rejects.toThrow('readLimit must be a positive integer')
    await expect(ctx.plugin(DocumentTools, { maxInputBytes: 1.5 })).rejects.toThrow('maxInputBytes must be a positive integer')
    await expect(ctx.plugin(DocumentTools, { maxOutputBytes: 'big' as never })).rejects.toThrow()
    await expect(ctx.plugin(DocumentTools, { pdfMaxPages: 0 })).rejects.toThrow('pdfMaxPages must be a positive integer')
    await expect(ctx.plugin(DocumentTools, { pdfProfile: 'tiny' as never })).rejects.toThrow()
  })

  it('unregisters the tool and prompt section when disposed (HMR safety)', async () => {
    const { ctx, fiber } = await mount(workspace())
    expect(ctx.tools.get('read_document')).toBeDefined()
    await fiber.dispose()
    expect(ctx.tools.get('read_document')).toBeUndefined()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('read_document')
  })
})

describe('pure helpers', () => {
  it('parseReadArgs defaults and validates', () => {
    const caps = { readLimit: 2000, pdfMaxPages: 100 }
    expect(parseReadArgs({ file_path: 'a.pdf' }, caps)).toEqual({ filePath: 'a.pdf', offset: 1, limit: 2000 })
    expect(parseReadArgs({ file_path: 'a.pdf', pages: '2-3' }, caps)).toEqual({ filePath: 'a.pdf', offset: 1, limit: 2000, pages: [2, 3] })
    expect(() => parseReadArgs({ file_path: '  ' }, caps)).toThrow('file_path must be a non-empty string')
    expect(() => parseReadArgs({ file_path: 'a.pdf', limit: 2001 }, caps)).toThrow('limit must be less than or equal to 2000')
  })

  it('formatReadOutput footers cover capped, partial, and complete windows', () => {
    const base = { path: '/d.pdf', format: 'pdf' as const, offset: 1, totalLines: 2, lines: [{ number: 1, text: 'a' }] }
    expect(formatReadOutput({ ...base, truncatedByBytes: true })).toContain('(Output capped. Showing lines 1-1. Use offset=2 to continue.)')
    expect(formatReadOutput({ ...base, truncatedByBytes: false })).toContain('(Showing lines 1-1 of 2. Use offset=2 to continue.)')
    expect(formatReadOutput({ ...base, totalLines: 1, truncatedByBytes: false })).toContain('(End of document - total 1 lines)')
    expect(formatReadOutput({ ...base, lines: [], offset: 5, totalLines: 2, truncatedByBytes: false })).toContain('(End of document - total 2 lines)')
  })

  it('formatReadOutput adds PDF facts and an OCR warning', () => {
    const base = { path: '/d.pdf', format: 'pdf' as const, offset: 1, totalLines: 1, lines: [{ number: 1, text: 'a' }], truncatedByBytes: false }
    expect(formatReadOutput({ ...base, pdf: { pageCount: 12, kind: 'mixed', pagesNeedingOcr: [3, 7, 8], pages: [1, 2, 3], title: 'Q3' } })).toContain([
      '<path>/d.pdf</path>',
      '<format>pdf</format>',
      '<pdf>12 pages, mixed text and scanned pages; showing pages 1-3; title: Q3</pdf>',
      '<warning>Pages 3, 7-8 contain no extractable text (scanned or image content); their content is missing below and would need OCR.</warning>',
      '<content>',
    ].join('\n'))
    expect(formatReadOutput({ ...base, pdf: { pageCount: 1, kind: 'text', pagesNeedingOcr: [] } })).toContain('<pdf>1 page, text-based; all pages</pdf>\n<content>')
  })
})
