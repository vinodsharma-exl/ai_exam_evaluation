# AnswerEval AI: Architecture (Phase 1)

AnswerEval AI is an offline-first Windows desktop app. It reads handwritten answer sheets with AI, **recommends** marks and feedback, and lets the professor review, edit and finalize them. There is no database and no online account. Everything lives in a local folder as JSON files plus page images and PDFs. The only network traffic is the AI calls the professor configures.

The main design driver is **free-tier AI keys**: few requests per minute, daily caps, small context windows and sometimes no vision support.

---

## 1. Process model

```
┌──────────────────────────── Electron main process (Node) ───────────────────────────┐
│                                                                                     │
│  FileStore ──── atomic JSON write (tmp → fsync → rename), schema migration          │
│  SecretStore ── safeStorage encrypt/decrypt → secrets.bin (keys never logged)       │
│  ConfigService  config.json (no keys)                                               │
│  StudentIndex ─ index/students.json (rebuilt by scanning folders if missing)        │
│                                                                                     │
│  Pipeline                                                                           │
│   ├─ JobRunner ─── reads/writes jobs.json per student; resumable task list          │
│   ├─ RequestQueue  one global queue → per-(provider,model) TokenBucket + DailyCap   │
│   │                 backoff with jitter on 429/5xx, honours Retry-After             │
│   ├─ ResponseCache cache/<ab>/<sha256>.json, key = hash(images+prompt+model)     │
│   ├─ UsageLedger ─ usage.json daily counters (persist across restarts)              │
│   └─ Providers ─── Gemini | Groq | OpenRouter | Mistral | OpenAI | Anthropic |      │
│                    Custom OpenAI-compatible | Mock                                  │
│                                                                                     │
│  PDF/Image: pdf.js (render pages) → sharp-free JPEG encode via OffscreenCanvas      │
│             in a hidden worker window; pdf-lib + pdfkit for reports; exceljs        │
└──────────────▲──────────────────────────────────────────────────────────────────────┘
               │ typed IPC (contextBridge, `window.api`, see src/shared/ipc.ts)
┌──────────────┴──────────────── Renderer (React + Vite + Tailwind) ──────────────────┐
│  Screens: Welcome · Dashboard · Upload · Exam Setup · Processing · Results ·        │
│  Question Detail · AI Feedback · Edit & Finalize · Report · Student Results ·       │
│  Exams/Batch · Settings                                                             │
│  No Node access, no keys, no direct network calls.                                  │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

Rules:

- The **renderer never sees an API key**. It sends "save key for provider X". Main encrypts the key and only ever reports `hasKey: true/false`.
- **All AI calls go through the RequestQueue**, including Test connection and Re-evaluate. Then no code path can bypass the rate limiter.
- The renderer has `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false`. It can only reach the whitelisted IPC channels.
- Page rendering (pdf.js → JPEG) happens in a hidden renderer worker window, so the main process never blocks. No native modules are needed, so the NSIS build stays simple.

---

## 2. Two-stage AI pipeline

```
 answer sheet (PDF / JPG / PNG, many files)
        │  render_pages  (local, no AI)  → pages/p001.jpg … grayscale JPEG, long edge ≤ 1600px
        ▼
 Stage A: OCR (vision model, e.g. Gemini Flash)
   ocr_pages  — groups of ≤ maxImagesPerRequest pages per call, each group ONE task
             → per-page "fragments" {question number | continued, text, diagram, illegible}
             → cached on disk; never repeated once done
        │  merge_answers (local, deterministic): stitch fragments into one answer per question,
        │  attach continuations to the previous question, detect skipped questions
        ▼
 Stage B: Evaluation (TEXT-only model, e.g. Groq Llama / Gemini / OpenRouter :free)
   evaluate_questions — batch as many questions as fit in the context window,
                        automatic fallback to 1 question per call on overflow or invalid JSON
             → per-criterion marks, correct / missing, feedback, confidence
        │  finalize_totals (local): clamp to max, round to the half/whole step,
        │  apply "attempt any N" rules, confidence < threshold → Needs Review
        ▼
 Professor review → final.json (with an audit trail) → report.pdf / class .xlsx
```

- Each stage has its **own provider, model and key**. For example, Gemini can do the OCR and Groq the grading.
- **No vision model?** The OCR task for that page becomes `manual`. The professor types or pastes the text in Question Detail. Stage B then works normally.
- The question paper and model answer use the same Stage A path (prompts a and b). They are extracted **once per exam** and saved into `exam.json`, which becomes the reusable exam template.

### Stage A batching and answers that span pages

Pages are sent in groups of `min(maxImagesPerRequest, 3)` (Low quality: up to 4). The prompt receives the **last question number seen** in the previous group, so it can label a continuation correctly. Fragments are stored per page, so editing a page's text or re-running one page never touches the others.

### Stage B batching

`estimateTokens(text) ≈ chars / 3.5` (deliberately pessimistic). Questions are packed greedily until `0.6 × contextWindow − maxOutputTokens` is reached. On `context_too_long`, a truncated response or JSON that is still invalid after one repair, the batch is split into single-question calls. The split is recorded in `jobs.json`, so a resume does not retry the failing batch.

---

## 3. Free-tier survival

| Concern | Mechanism |
|---|---|
| RPM limits | Token bucket per `provider:model`: capacity = RPM, refill = RPM/60 per second. Also a minimum gap of `60/RPM` seconds, because many free tiers reject bursts. |
| Daily caps | `usage.json` keeps counters per `provider:model` per local date. When a cap is reached, the job goes to `paused` (reason `quota_exhausted`) and the UI shows "Daily limit reached. Resume tomorrow or switch model in Settings." |
| 429 / 5xx | Exponential backoff: `min(60s, 2s × 2^attempt) × (0.5…1.5 jitter)`. A `Retry-After` header (seconds or HTTP date) or a Gemini `RetryInfo.retryDelay` overrides it. Up to 6 attempts, then the task fails with a clear error. A 429 also drains that bucket, so other queued calls wait too. |
| Visible waiting | The queue emits `{state:'waiting_rate_limit', resumeAt}` and the UI counts down: "Waiting for rate limit, resuming in 42s". |
| Re-billing | The task is marked `done` only **after** its result and the cache entry are written atomically. On startup, `running` tasks go back to `pending`. The cache then turns a repeated call into a free hit. |
| Image size | Low ≈ 110 DPI / 1200px / q60, Medium ≈ 130 DPI / 1400px / q70, High ≈ 150 DPI / 1600px / q80, all grayscale. Blank pages (very low ink variance) are detected locally and skipped. |
| Caching | `cache/<ab>/<sha256(model ‖ promptVersion ‖ system ‖ user ‖ imageHashes)>.json`. Changing strictness changes the prompt, which changes the key, so re-grading is correct. Re-evaluate bypasses the cache on purpose. |
| Usage estimate | Before starting: `ocrRequests = Σ ceil(pages / groupSize)`, `evalRequests = ceil(questions / batchSize)`. Then `minutes = max over stages of requests / RPM`. Shown as "~24 requests, about 6 minutes on your free limit, 226 left today". |
| Invalid JSON | JSON mode or a response schema where supported. Otherwise the JSON is taken from the text (code fences, first balanced `{…}`). Validated with zod. **One** repair call with the zod errors. Then failure, or a split batch for evaluation. |
| Safety rails | Marks are clamped to `[0, max]` per criterion and per question and rounded to the step. Confidence < 0.6 (configurable) sets **Needs Review**. All AI output is labelled **Recommended**. |

---

## 4. Data folder layout

Default: `%USERPROFILE%\Documents\AnswerEvalAI\`. The location is stored in `%APPDATA%\AnswerEval AI\bootstrap.json` (`{ "dataDir": "…" }`). It cannot live inside the data folder, because the app has to find the folder first.

```
AnswerEvalAI/
  config.json                 settings, no keys                      (ConfigFile)
  secrets.bin                 safeStorage-encrypted SecretsPayload
  profile.json                local profile, scrypt PIN hash         (ProfileFile)
  usage.json                  daily request counters                 (UsageFile)
  queue.json                  global "Process all" order             (GlobalQueueFile)
  cache/<ab>/<sha256>.json    AI response cache (sharded by first 2 hex chars)                      (CacheEntry)
  index/students.json         search index, rebuildable              (StudentIndexFile)
  backups/                    ZIP backups (Settings → Backup)
  exams/<examId>/
    exam.json                 exam template: questions, marking pts  (ExamFile)
    source/question_paper.pdf
    source/model_answer.pdf
    source/pages/qp_p001.jpg, ma_p001.jpg
    source/extraction.json    raw page OCR for the sources           (SourceExtractionFile)
    students/<studentId>/
      student.json            name, roll no                          (StudentFile)
      submission.pdf          merged copy of everything uploaded
      uploads/u001.pdf …      original uploads (kept for re-rendering after rotation)
      pages/p001.jpg …        normalised page images (what the AI sees)
      pages/thumbs/p001.jpg   thumbnails for the page grid
      extraction.json         per-page fragments + merged answers    (ExtractionFile)
      evaluation.json         AI recommendations                     (EvaluationFile)
      final.json              professor's final marks + audit trail  (FinalFile)
      report.pdf
      jobs.json               resumable task list                    (JobsFile)
```

There are a few additions to the layout in the brief. Each one is needed:

- `profile.json`: the local login.
- `student.json`: search by name needs the name stored somewhere.
- `usage.json`: daily caps must survive a restart.
- `queue.json`: "Process all" order across students.
- `cache/`: the response cache, sharded so no single folder holds thousands of files.
- `source/extraction.json`: question paper OCR is cached too.

**File rules**

- Every write is atomic: write `name.json.tmp`, fsync, rename over `name.json`. On Windows the rename is retried for up to 1s on `EPERM`/`EBUSY`, because antivirus and indexers hold files briefly.
- Every file has `schemaVersion`. The loader runs `migrations[file][from→to]` and then validates with zod. An invalid file is renamed to `*.corrupt-<timestamp>.json` and is never silently deleted.
- IDs are folder-safe: `[A-Za-z0-9._-]`, 1–64 characters, and not a Windows reserved name. A student ID like `21/CS/045` is stored as the folder `21-CS-045`, and the original is kept in `student.json.displayId`.
- The index is a cache. If it is missing or fails validation, it is rebuilt by scanning `exams/*/students/*`.

JSON Schemas generated from the zod source of truth are in [`/schemas`](../schemas). Run `npm run schemas` to regenerate them.

---

## 5. Job queue and resume semantics

`jobs.json` holds an ordered list of tasks for one student:

```
render_pages → ocr_pages(g1) → ocr_pages(g2) … → merge_answers → evaluate_questions(b1) … → finalize_totals
```

- Tasks are **idempotent**. Each one writes its output, then marks itself done in one atomic `jobs.json` write.
- On app start, `running` tasks become `pending` (with `attempts` kept). Job state `running` becomes `paused`, with reason `app_closed`.
- **Resume** runs the first non-`done` task. `done` tasks are never re-run, unless the professor asks for it ("Re-run OCR for page 3" or "Re-evaluate Q4"). Those requests add a new task. They never rewrite old ones.
- Editing extracted text marks the affected `evaluate_questions` work stale. The UI offers "Re-evaluate changed questions". It is never automatic, so no hidden requests are spent.
- The global `queue.json` lists `examId/studentId` pairs for "Process all". One runner works through them **one student at a time**, sharing the rate limiter.
- Pause reasons: `user`, `rate_limit_daily`, `network`, `auth`, `app_closed`, `no_vision_model`. Each maps to a next-action message (src/shared/errors.ts).

---

## 6. Provider adapters

`src/shared/providers/types.ts` defines `ProviderAdapter`. Each adapter only turns a `CompletionRequest` into an HTTP call and maps errors to a `ProviderErrorKind`. Rate limiting, caching, retries and JSON validation live outside the adapters, so all providers get them the same way.

Capabilities (`ModelCapabilities`) are kept **per model**, because free quotas are per model. Defaults come from `src/shared/providers/catalog.ts`. The user can edit every value in Settings. Test connection sends a tiny text probe and then a tiny vision probe: an embedded 1-bit image of the word "TEST". It records `lastTest` with the result.

> Free-tier limits and model names change often. Catalog defaults are deliberately **conservative**. The app relies on the values the user can edit, plus `Retry-After`, never on the catalog alone.

---

## 7. Planned source tree (all phases)

```
ExamEva/
  package.json  tsconfig*.json  vite.config.ts  electron-builder.yml  tailwind.config.ts
  docs/ARCHITECTURE.md  docs/PROFESSOR_GUIDE.md  docs/TEST_CHECKLIST.md
  schemas/*.schema.json                     generated JSON Schemas
  scripts/generate-json-schemas.ts
  src/
    shared/                                  pure TS, used by main and renderer
      constants.ts  paths.ts  errors.ts  ipc.ts
      schemas/  common.ts config.ts profile.ts exam.ts student.ts extraction.ts
                evaluation.ts final.ts jobs.ts index-file.ts usage.ts cache.ts
                ai-output.ts index.ts
      providers/ types.ts catalog.ts
      prompts/   templates.ts
    main/                                    Phase 2–3
      main.ts  preload.ts  window.ts  ipc-handlers.ts
      store/ atomic-write.ts file-store.ts migrations.ts config-service.ts
             secret-store.ts profile-service.ts student-index.ts backup.ts
      jobs/  job-store.ts job-runner.ts global-queue.ts
      ai/    rate-limiter.ts request-queue.ts backoff.ts cache.ts usage-ledger.ts
             json-repair.ts estimator.ts pipeline.ts merge-answers.ts grading-math.ts
             providers/ gemini.ts openai-compatible.ts anthropic.ts mock.ts index.ts
      pdf/   render-worker.html render-worker.ts image-utils.ts
      report/ student-report.ts class-sheet.ts
    renderer/                                Phase 4–5
      index.html main.tsx App.tsx api.ts theme.css
      components/ Sidebar Card StatCard DataTable Stepper Dropzone PageThumb
                  ConfidenceBadge RecommendedTag RateLimitBanner Chart …
      screens/   Welcome Dashboard UploadSheet ExamSetup Processing Results
                 QuestionDetail AiFeedback EditFinalize Report StudentResults
                 Exams Settings PrivacyNotice
      hooks/     useShortcuts useJobProgress …
  tests/        rate-limiter json-repair file-store resume grading-math prompts schemas
```

---

## 8. Keyboard shortcuts (planned)

| Key | Action |
|---|---|
| `Alt+→` / `Alt+←` (also `]` / `[` outside text fields) | Next / previous question |
| `Ctrl+S` | Save |
| `Ctrl+Enter` | Save and next |
| `Ctrl+F` | Focus the student search box |
| `Ctrl+R` | Re-evaluate the current question (asks for confirmation, because it costs 1 request) |
| `Esc` | Close dialog / cancel edit |
