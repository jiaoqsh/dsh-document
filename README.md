# dsh-document

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin bundle (`@jiaoqsh/dsh-document`) that gives the model a `read_document` tool: Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, and PDF files are converted to line-numbered Markdown the model can page through with `offset`/`limit`.

Conversion runs locally through [`@firecrawl/anydoc`](https://github.com/firecrawl/anydoc) (Rust core, Node bindings, MIT): no API key, no network, no external binaries. Files are read through the harness `ctx.fs` seam, so whatever filesystem provider and sandbox policy a deployment mounts applies unchanged.

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
```

| Key | Default | Meaning |
|---|---|---|
| `maxInputBytes` | 52428800 (50 MiB) | Inclusive byte cap on the source file. Enforced by the filesystem provider before any bytes are buffered; larger files are refused. |
| `readLimit` | 2000 | Default and maximum number of Markdown lines returned by one call. |
| `maxLineLength` | 2000 | Maximum characters per returned line; overflow is cut with `… [line truncated]`. |
| `maxOutputBytes` | 51200 (50 KiB) | Maximum bytes of line text returned by one call; the window stops early and the footer says how to continue. |

Every value must be a positive integer; anything else fails the plugin load with a message naming the key.

## The tool

`read_document(file_path, offset?, limit?)`

- `file_path` — resolved by the filesystem backend; relative paths resolve against the calling session's workspace.
- `offset` — 1-based first line of the converted Markdown (default 1).
- `limit` — lines to return (default and maximum `readLimit`).

Supported extensions: `.pdf`, `.doc`, `.docm`, `.docx`, `.ppt`, `.pps`, `.pot`, `.pptx`, `.pptm`, `.ppsx`, `.ppsm`, `.xls`, `.xlsx`, `.xlsm`, `.xlsb`, `.odt`, `.ods`, `.odp`, `.rtf`, `.epub`, `.csv`. The format comes from the extension, never from content sniffing (CSV has no signature).

Canonical value (what Code Mode receives):

```ts
{ path: string, format: 'pdf' | 'docx' | ..., offset: number,
  lines: { number: number, text: string }[], totalLines: number, truncatedByBytes: boolean }
```

Model-facing text:

```text
<path>/work/report.pdf</path>
<format>pdf</format>
<content>
1: ## Quarterly Report
2: 
3: Revenue grew 12% year over year.

(Showing lines 1-3 of 540. Use offset=4 to continue.)
</content>
```

Failures are tool errors in model terms: unsupported extension (pointing at `read` for plain text), not found, not a regular file, over `maxInputBytes`, encrypted, damaged or incomplete, engine resource limit, or no extractable text (scanned or image-only documents; this tool performs no OCR).

## Model Experience

### System prompt section `tool:read_document`

#### What the model sees

One fixed sentence, order 100 beside the shipped `tool:read` guidance:

```markdown
Use the read_document tool — not read or shell commands — to inspect PDF, Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, and CSV files. It returns the document converted to line-numbered Markdown; use offset and limit to continue reading long documents.
```

#### Token effect

Fixed: the section and the tool schema add a constant number of tokens to every request; results add up to `maxOutputBytes` per call.

#### KV Cache effect

Prefix-stable: the section text and schema never change between requests, so they do not invalidate a cached prompt prefix.

## Known Limitations and Deferred Work

- **No OCR** — scanned or image-only PDFs fail with a message saying so; nothing tells the model *which* pages lack text.
- **PDF page structure is not exposed** — anydoc returns one Markdown string, so long PDFs are paged by line, not by page, and layout-heavy PDFs may collapse paragraphs into long lines (then cut by `maxLineLength`).
- **Conversion is not cancellable** — the Rust call runs to completion once started; `maxInputBytes` is the bound. Cancellation is honored before the call.
- **Roadmap** — route PDFs through [`@firecrawl/pdf-inspector`](https://github.com/firecrawl/pdf-inspector) for `pages` selection, page markers, `pdfType`, and per-page OCR flags; the `DocumentConverter` interface in `src/converter.ts` is the seam. Note its native build ships no `darwin-x64` binary; the WASM build works under Node.

## Development

```sh
pnpm install          # also builds lib/ via prepare
pnpm run typecheck
pnpm test             # real Cordis Context + real registry + real local fs; no API key
pnpm run build
```

Fixtures under `tests/fixtures/` were generated once with macOS `textutil` and `cupsfilter` and are committed so the suite runs anywhere.

## License

MIT
