# Cheque Scanner

Browser-first multi-cheque field extractor for GCC / Qatari bank cheques, with an
optional single-binary desktop build. TypeScript + SvelteKit; PDFs are rendered
and segmented **in the browser** (pdf.js + Canvas). The Anthropic API key is held
by a backend — a thin SvelteKit server route on the web, or the Rust process in
the desktop app — and never reaches the renderer in either case.

Per cheque it extracts amount (with legal/courtesy reconciliation), currency,
date, payer, bank, cheque number and a handwriting flag, plus a confidence score
and review flags.

## Dependency story

The browser already ships a PDF renderer and image stack, so the heavy Python
dependencies disappear. **The only runtime dependency is `pdfjs-dist`.**

| Python build | Here |
| --- | --- |
| PyMuPDF | pdf.js (`pdfjs-dist`) |
| numpy | typed-array image ops |
| Pillow | Canvas + hand-written ops |
| anthropic SDK | raw `fetch` (web) / `reqwest` (desktop) |
| PyQt6, threading, PyInstaller | SvelteKit + `mapPool`; Tauri for desktop |

Everything else is build-time tooling. The desktop wrapper adds `@tauri-apps/cli`
(dev only) and a Rust crate; the web bundle is unchanged (Tauri is reached through
the injected global, so there is no `@tauri-apps/api` runtime dependency).

## Accuracy features

1. **Legal/courtesy reconciliation gate** — the model returns both the numeric
   amount and its numeric reading of the written words; the client compares them
   (0.5% tolerance) and flags disagreement, preferring the words value (legally
   controlling).
2. **Deterministic validators** — calendar-valid dates, fixed-length MICR cheque
   numbers, currency inferred from the bank, Eastern-Arabic numeral folding.
3. **Cheap-first, escalate-on-flag** — read with Sonnet/Haiku; re-read only
   flagged cheques with Opus and keep the better result.
4. **Per-bank few-shot on re-reads** — once a pass identifies the bank, the
   escalation/self-consistency re-read is given bank-specific layout guidance
   plus **exemplars learned from your own review-pane corrections**. Corrections
   are verified ground truth, so accuracy compounds on banks you process often.
5. **Self-consistency** (optional) — sample flagged amounts several times and
   majority-vote.
6. **Human-in-the-loop review pane** — click a cheque, see the exact crop, fix
   fields inline. The biggest lever on effective accuracy.

Segmentation is deterministic first (ink-density projection → bands → gutter
merge) and consults a vision-LLM fallback only on ambiguous pages. It fails safe:
when unsure it treats the page as a single cheque, so it never corrupts a normal
one-cheque-per-page scan.

## Persistence

- **Results metadata** → `localStorage` (small, fast), restored on load.
- **Cheque crops** → **IndexedDB** (no 5MB cap), so the review pane shows the real
  crop even after closing and reopening the app.
- **Learned exemplars** → `localStorage`, keyed by bank.

## Providers & API key

The provider is chosen by the selected model: **Gemini 2.5 Flash-Lite** is the default (escalating to **Gemini 2.5 Pro** on flagged cheques), and the Claude models remain selectable. Enter the key for the active provider in **Settings** — it's stored locally in your browser — or leave it blank and set an environment variable instead (`GEMINI_API_KEY` or `ANTHROPIC_API_KEY`). A key entered in Settings takes precedence. Either way the key only ever reaches the backend (the web server route or the Rust desktop process), never the page itself. Gemini is called through its OpenAI-compatible endpoint with a forced function call, so the structured-output contract is identical to the Claude path.

## Run on the web

Requires Node 18+.

```bash
cp .env.example .env          # optional: set GEMINI_API_KEY (or just paste the key in Settings)
npm install
npm run dev                   # http://localhost:5173
# production:
npm run build && npm run start
```

The key is read only by `src/routes/api/extract/+server.ts`.

## Build the desktop app (single binary)

The desktop app uses Tauri v2: the SvelteKit frontend is built as a static SPA and
bundled into a native binary, and the Anthropic call runs in Rust
(`src-tauri/src/main.rs`) so the key stays out of the webview.

Prerequisites (one-time):
- Rust toolchain — https://rustup.rs
- Your OS's webview build deps — see https://tauri.app/start/prerequisites/
  (Linux: `webkit2gtk-4.1` + `libgtk-3-dev` etc.; macOS: Xcode CLT; Windows:
  WebView2 + MSVC build tools).

Then:

```bash
npm install
# Optional: replace the placeholder icons with your logo (regenerates all formats)
npx tauri icon ./app-icon.png

# Dev (hot-reload in a native window):
npm run tauri:dev

# Produce the installer / binary for your OS:
npm run tauri:build
# output under src-tauri/target/release/bundle/
```

The desktop app reads `ANTHROPIC_API_KEY` from the environment or a `.env` in the
run directory (loaded via dotenvy). Set it before launching.

Placeholder icons are included so the build works immediately; `generate-icons.mjs`
regenerates them (`node generate-icons.mjs`).

## Architecture

```
Browser (web + desktop share this code)
────────────────────────────────────────
pdf.js render page  ─┐
                     ├─ deterministic segmentation (typed arrays)
crop each cheque  ───┘        │ ambiguous → optional LLM region call
   │                          ▼
   └── transport shim ───────────────────────────────────────────────►
                          web:     POST /api/extract  (SvelteKit route, key in env)
                          desktop: invoke('extract_cheque') (Rust, key in env)
   ◄────────────── structured fields ◄──────────── forced tool_use + retry/backoff
   │
   validate + reconcile + (bank few-shot) escalate flagged → table → review → CSV
```

The image/segmentation/validation code operates on a minimal `Img`
(`{data, width, height}`), so the same code runs in the browser (real `ImageData`)
and in node tests. Key modules under `src/lib`: `pdf/render.ts`,
`segmentation/detect.ts`, `image/ops.ts`, `extract/{normalize,validate,rois,prompt,fewshot}.ts`,
`pipeline.ts`, `concurrency.ts`, `llm/{transport,client}.ts`,
`storage/cropStore.ts`, `stores.ts`. Backends: `src/routes/api/extract/+server.ts`
(web) and `src-tauri/src/main.rs` (desktop).

## Verified here

- `npm run build` (adapter-node) and `npm run build:tauri` (adapter-static SPA)
  both succeed.
- `svelte-check`: 0 errors, 0 warnings.
- 43 pure-logic unit tests pass (`npm run test`): segmentation, normalization,
  the reconciliation gate, handover detection, cheque-number validation,
  concurrency, and bank few-shot hinting.
- The substantive Rust (JSON tool schemas, prompt+hint building, tool_use
  parsing) was compiled and checked in isolation.

## Honest caveats

- The browser↔LLM round trip needs a real key + browser and is not exercised by
  the test suite.
- The **desktop binary itself must be compiled on a machine with the Rust
  toolchain and your platform's webview libs** — that couldn't be compiled in the
  build sandbox (no webkit2gtk/GTK). The Rust source is complete and its core
  logic is verified; the rest is standard Tauri v2 glue.
- Classical segmentation thresholds are tuned conservatively (fail safe to
  single-cheque); side-by-side (2-up) cheques route through the LLM fallback.
- Bank ROIs and few-shot hints are seeds ported from the Python build — refine
  them against your own scans (and the exemplar learning will do the rest).
