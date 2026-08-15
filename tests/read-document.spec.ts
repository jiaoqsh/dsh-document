/**
 * Real-composition tests: a real Cordis Context with the published tool
 * registry, system-prompt registry, and local filesystem provider; only the
 * model is absent. Calls go through `ctx.tools.execute`, the entry the agent
 * loop uses.
 */

import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { anydocConverter } from '../src/converter.ts'
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

describe('anydoc converter', () => {
  const converter = anydocConverter()

  it('maps extensions case-insensitively and rejects unknown ones', () => {
    expect(converter.formatOf('/tmp/Report.PDF')).toBe('pdf')
    expect(converter.formatOf('slides.pptm')).toBe('pptx')
    expect(converter.formatOf('legacy.xls')).toBe('xlsx')
    expect(converter.formatOf('notes.txt')).toBeUndefined()
    expect(converter.formatOf('archive.tar.gz')).toBeUndefined()
  })

  it('reports engine failures with a stable code', async () => {
    await expect(converter.toMarkdown(new Uint8Array([1, 2, 3]), 'docx'))
      .rejects.toMatchObject({ name: 'DocumentConversionError', code: expect.stringMatching(/malformed|missingPart|unsupported/) })
    await expect(converter.toMarkdown(new Uint8Array(), 'csv'))
      .rejects.toMatchObject({ code: 'empty' })
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
    expect(text(pdf)).toContain('<format>pdf</format>')
    expect(text(pdf)).toContain('… [line truncated]')
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
    expect(parseReadArgs({ file_path: 'a.pdf' }, 2000)).toEqual({ filePath: 'a.pdf', offset: 1, limit: 2000 })
    expect(() => parseReadArgs({ file_path: '  ' }, 2000)).toThrow('file_path must be a non-empty string')
    expect(() => parseReadArgs({ file_path: 'a.pdf', limit: 2001 }, 2000)).toThrow('limit must be less than or equal to 2000')
  })

  it('formatReadOutput footers cover capped, partial, and complete windows', () => {
    const base = { path: '/d.pdf', format: 'pdf' as const, offset: 1, totalLines: 2, lines: [{ number: 1, text: 'a' }] }
    expect(formatReadOutput({ ...base, truncatedByBytes: true })).toContain('(Output capped. Showing lines 1-1. Use offset=2 to continue.)')
    expect(formatReadOutput({ ...base, truncatedByBytes: false })).toContain('(Showing lines 1-1 of 2. Use offset=2 to continue.)')
    expect(formatReadOutput({ ...base, totalLines: 1, truncatedByBytes: false })).toContain('(End of document - total 1 lines)')
    expect(formatReadOutput({ ...base, lines: [], offset: 5, totalLines: 2, truncatedByBytes: false })).toContain('(End of document - total 2 lines)')
  })
})
