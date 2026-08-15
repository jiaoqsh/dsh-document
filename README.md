# dsh-document

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin bundle (`@jiaoqsh/dsh-document`) that gives the model a `read_document` tool: Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, and PDF files are converted to line-numbered Markdown the model can page through with `offset`/`limit`.

Conversion runs locally: office formats through [`@firecrawl/anydoc`](https://github.com/firecrawl/anydoc) (Rust core, Node bindings) and PDFs through [`@firecrawl/pdf-inspector`](https://github.com/firecrawl/pdf-inspector) (WASM build, run in a worker thread) — no API key, no network, no external binaries; both MIT. PDFs get page selection, `<!-- Page N -->` markers, and page facts: total pages, text-based / scanned / mixed, and which pages have no extractable text. Files are read through the harness `ctx.fs` seam, so whatever filesystem provider and sandbox policy a deployment mounts applies unchanged.

## Install

Into an existing profile (`web`, `headless`, or your own):

```sh
dsh plugin --profile web add github:jiaoqsh/dsh-document#<commit-sha>
```

pnpm ≥ 10 refuses to run a git dependency's `prepare` script until you allow it; the first `add` fails and prints the exact key to copy into the profile's `pnpm-workspace.yaml` (`$DSH_HOME/profiles/<name>/pnpm-workspace.yaml`). The key names the resolved tarball, so a bare package name does not match:

```yaml
allowBuilds:
  '@jiaoqsh/dsh-document@https://codeload.github.com/jiaoqsh/dsh-document/tar.gz/<commit-sha>': true
```

Re-run the `add`. Allowing the build means executing this package's `prepare` (a `tsdown` transpile of `src/`) on your machine at install time; pin a commit so a later push cannot change what runs. A packed tarball (`pnpm pack` → `dsh plugin add ./jiaoqsh-dsh-document-<version>.tgz`) needs no allowance.

`dsh plugin` prints "missing peer" warnings for the `@deepseek-ai/*` packages: expected. The dsh installation supplies them at runtime; profiles deliberately do not install peers.

Verify, then boot:

```sh
dsh --profile web --dump-config   # shows a "# == @jiaoqsh/dsh-document" layer
dsh --profile web
```

Remove with `dsh plugin --profile web remove @jiaoqsh/dsh-document`.

### From a source checkout of the harness

```sh
pnpm dsh web --patch /absolute/path/to/dsh-document/overlay.yml
```

where the overlay inserts the built entry by absolute path:

```yaml
- insert:
    - id: document-tools
      name: '/absolute/path/to/dsh-document/lib/index.js'
```

## Configuration

The bundle's layer inserts one row, `document-tools`, with schema defaults. Override it by id in your profile's `cordis.patch.yml`; a patch replaces the whole `config`, so restate every key you need:

```yaml
- id: document-tools
  config:
    maxInputBytes: 104857600   # 100 MiB
    readLimit: 2000
    maxLineLength: 2000
    maxOutputBytes: 51200
    pdfMaxPages: 100
    pdfProfile: fidelity
```

| Key | Default | Meaning |
|---|---|---|
| `maxInputBytes` | 52428800 (50 MiB) | Inclusive byte cap on the source file. Enforced by the filesystem provider before any bytes are buffered; larger files are refused. |
| `readLimit` | 2000 | Default and maximum number of Markdown lines returned by one call. |
| `maxLineLength` | 2000 | Maximum characters per returned line; overflow is cut with `… [line truncated]`. |
| `maxOutputBytes` | 51200 (50 KiB) | Maximum bytes of line text returned by one call; the window stops early and the footer says how to continue. |
| `pdfMaxPages` | 100 | Maximum distinct pages one `pages` selection may name. |
| `pdfProfile` | `fidelity` | PDF Markdown profile: `fidelity` keeps source structure, `compact` spends fewer tokens. |

Every numeric value must be a positive integer and `pdfProfile` one of the two names; anything else fails the plugin load with a message naming the key.

## The tool

`read_document(file_path, offset?, limit?, pages?)`

- `file_path` — resolved by the filesystem backend; relative paths resolve against the calling session's workspace.
- `offset` — 1-based first line of the converted Markdown (default 1).
- `limit` — lines to return (default and maximum `readLimit`).
- `pages` — PDF only: 1-based pages to convert, as numbers and ranges like `"1-3,7"` (at most `pdfMaxPages`). Default: every page. Naming a page beyond the last one is an error that states the page count.

Supported extensions: `.pdf`, `.doc`, `.docm`, `.docx`, `.ppt`, `.pps`, `.pot`, `.pptx`, `.pptm`, `.ppsx`, `.ppsm`, `.xls`, `.xlsx`, `.xlsm`, `.xlsb`, `.odt`, `.ods`, `.odp`, `.rtf`, `.epub`, `.csv`. The format comes from the extension, never from content sniffing (CSV has no signature).

Canonical value (what Code Mode receives):

```ts
{ path: string, format: 'pdf' | 'docx' | ..., offset: number,
  lines: { number: number, text: string }[], totalLines: number, truncatedByBytes: boolean,
  pdf?: { pageCount: number, kind: 'text' | 'scanned' | 'image' | 'mixed',
          pagesNeedingOcr: number[], pages?: number[], title?: string } }
```

Model-facing text (a PDF, pages 2 and 4 of 5):

```text
<path>/work/report.pdf</path>
<format>pdf</format>
<pdf>5 pages, text-based; showing pages 2, 4</pdf>
<content>
1: <!-- Page 2 -->
2: 
3: Revenue grew 12% year over year.

(Showing lines 1-3 of 8. Use offset=4 to continue.)
</content>
```

A mixed PDF adds `<warning>Pages 3, 7-8 contain no extractable text (scanned or image content); their content is missing below and would need OCR.</warning>` before `<content>`. Non-PDF formats omit the `<pdf>` line.

Failures are tool errors in model terms: unsupported extension (pointing at `read` for plain text), `pages` on a non-PDF, a malformed `pages` value, not found, not a regular file, over `maxInputBytes`, encrypted, damaged or incomplete, engine resource limit, a page beyond the last page, cancellation, or no extractable text (a scanned or image-only PDF says so and that OCR is needed; this tool performs no OCR).

## Model Experience

### System prompt section `tool:read_document`

#### What the model sees

One fixed sentence, order 100 beside the shipped `tool:read` guidance:

```markdown
Use the read_document tool — not read or shell commands — to inspect PDF, Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, and CSV files. It returns the document converted to line-numbered Markdown; use offset and limit to continue reading long documents. For a PDF, pass pages (for example "1-3,7") to read only those pages; page markers like <!-- Page 4 --> show where each page starts.
```

#### Token effect

Fixed: the section and the tool schema add a constant number of tokens to every request; results add up to `maxOutputBytes` per call.

#### KV Cache effect

Prefix-stable: the section text and schema never change between requests, so they do not invalidate a cached prompt prefix.

## Known Limitations and Deferred Work

- **No OCR** — pages without a text layer are reported (`pagesNeedingOcr`, the `<warning>` line) but not read; a fully scanned or image-only PDF is an error naming the cause.
- **PDF conversion runs in a fresh worker thread per call** — cancellation terminates it, and the harness event loop stays free, at the cost of ~50 ms of WASM start-up per call. Office-format conversion (anydoc) runs on the libuv thread pool and cannot be cancelled once started; `maxInputBytes` is its bound.
- **Layout-heavy PDFs may collapse paragraphs into long lines** (then cut by `maxLineLength`); `pdfProfile: compact` trades structure for tokens.
- **Engines are fixed** — the `DocumentConverter` interface and `routeConverters` in `src/converter.ts` are the seam for a hosted or OCR-capable engine; none is wired today.
- **The pdf-inspector native binary is not used** — its npm build ships no `darwin-x64` binary, so the WASM build runs everywhere for one code path.

## Development

```sh
pnpm install          # also builds lib/ via prepare
pnpm run typecheck
pnpm test             # real Cordis Context + real registry + real local fs; no API key
pnpm run build
```

Fixtures under `tests/fixtures/` were generated once with macOS `textutil` and `cupsfilter` (including a five-page PDF and an image-only PDF) and are committed so the suite runs anywhere. In source mode the PDF worker is spawned as `.ts` with `--experimental-strip-types`, so it stays free of TypeScript-only runtime syntax.

## License

MIT
