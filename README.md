# AnswerEval AI

A Windows desktop app that helps a professor evaluate handwritten answer sheets. The AI reads the pages and **recommends** marks with feedback; the professor reviews, edits and finalizes them, then exports PDF reports and an Excel class sheet.

- **No database, no account.** Everything is JSON, page images and PDFs in `Documents\AnswerEvalAI`.
- **One installer**, nothing else to install, works offline except for the AI calls.
- **Built for free AI keys:** a two-stage pipeline (vision reading, then text-only grading), per-model rate limiting, daily caps, backoff with Retry-After, response caching and resumable jobs that never re-send finished work.

| Read | Path |
|---|---|
| Professor's one-page guide (free Gemini key) | [docs/PROFESSOR_GUIDE.md](docs/PROFESSOR_GUIDE.md) |
| Architecture, data layout, free-tier design | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Build and release | [docs/BUILD.md](docs/BUILD.md) |
| Test checklist | [docs/TEST_CHECKLIST.md](docs/TEST_CHECKLIST.md) |
| AI prompts (exact templates) | [src/shared/prompts/templates.ts](src/shared/prompts/templates.ts) |
| File schemas (JSON Schema) | [schemas/](schemas/) |

```powershell
npm install
npm run dev        # run with hot reload
npm test           # unit + integration tests
npm run test:ui    # drive the real app through every screen (offline mock AI)
npm run dist       # → release\AnswerEval-AI-Setup-<version>.exe
```
