# Test checklist

Tick each box before giving a build to the professor. Automated checks come first; then the manual checks that need a real AI key, real scans, or a person looking.

## A. Automated (every build)

- [ ] `npm run typecheck`: no errors
- [ ] `npm test`: all tests pass (127 at v0.1.0). Covers the rate limiter, JSON validation/repair, file store, resume logic, providers, grading maths, merge, pipeline, reports
- [ ] `npm run test:ui`: "UI walkthrough passed" (25 steps); skim the screenshots
- [ ] `npm audit --omit=dev`: 0 vulnerabilities
- [ ] `npm run dist` produces `release\AnswerEval-AI-Setup-<version>.exe`

## B. Installer (on a clean Windows user account if possible)

- [ ] Installer runs without admin rights; SmartScreen "Run anyway" works if unsigned
- [ ] Start-menu and desktop shortcuts appear with the cap icon
- [ ] First launch shows the profile screen, then the privacy notice once
- [ ] `--selftest-render` on a scanned PDF, a phone JPG and a typed PDF: all exit 0
- [ ] `node scripts/ui-walkthrough.mjs --exe "<installed exe>"` passes against the installed app
- [ ] Installing a newer version over an older one keeps all data
- [ ] Uninstall removes the app; `Documents\AnswerEvalAI` is still there

## C. Real AI provider (free Gemini key)

- [ ] Settings → Providers & keys: paste key → Save → **Test** on gemini-2.5-flash shows "Connected · vision ✓"
- [ ] Wrong key → Test shows "API key not accepted"; processing pauses with **Open API key settings**
- [ ] Settings → AI models → refresh button lists the models the key can use
- [ ] Question paper: typed PDF → "Read from the PDF text" (route: text-layer); handwritten photo → vision route; both give a sensible editable table
- [ ] Model answer: marking points add up to max marks (or a warning says they don't)
- [ ] Evaluate 1 real handwritten sheet (3–5 pages): text is readable, answers mapped to the right questions, marks ≤ max, Needs Review on unclear ones
- [ ] Answers that continue onto the next page are joined; crossed-out text is left out; unreadable words show `[illegible]`
- [ ] A question the student skipped shows "Not attempted", 0 marks, no request used

## D. Free-tier behaviour

- [ ] Set Limits for Flash to 2/min: requests are spaced ~30 s apart and the countdown "resuming in …" is shown
- [ ] Set daily limit to current usage + 1: job pauses with "Today's free limit is used up"; nothing is re-sent after raising the limit and pressing Resume
- [ ] Close the app during processing → reopen → job shows Paused (app closed) → Resume continues at the same page; usage counter rises only for new work
- [ ] Unplug network during processing → pauses with "No internet connection" after a few retries → Resume works
- [ ] Re-evaluate one question = exactly 1 request (usage counter)
- [ ] "Process all (queued)" with 5+ students runs one student at a time; Pause all / Resume work
- [ ] Choose a text-only model (e.g. Groq Llama) for Reading → job pauses with "This model cannot read images" → **Type the text instead** works and grading completes

## E. Review and reports

- [ ] Question Detail: Previous/Next and `Alt ←/→`; image tab shows the right pages; edited text → "Re-evaluate" offered
- [ ] Edit marks: 0.5 steps allowed only when half marks are on; above-max is refused; reason appears in the audit trail
- [ ] "Answer any N" exam: lowest answers are dropped from the total and marked "not counted"
- [ ] Finalize → report without DRAFT watermark; un-finalized → report with DRAFT watermark
- [ ] PDF opens in Edge/Acrobat; names with accents print correctly; private notes are not printed; review reasons are not printed
- [ ] Excel class sheet opens; marks are numbers; Average/Highest/Lowest formulas work; "Marks source" says Final / Draft / AI recommended
- [ ] Charts show sensible bars; Table toggle shows the same numbers; tooltips work with mouse and Tab key

## F. Data safety

- [ ] Settings → Data → Create backup → Restore from that backup on another folder; everything reappears; keys must be re-entered
- [ ] Change data folder with "copy my data" → app uses the new folder; old folder still exists
- [ ] Corrupt a JSON file by hand (e.g. delete half of `exam.json`) → app shows "A data file is damaged", file is renamed `.corrupt-…`, not deleted
- [ ] Delete `index\students.json` → Student search still works (index rebuilt)
- [ ] `secrets.bin` contains no readable key; `main.log` contains no key and no student text

## G. Usability and accessibility

- [ ] Every screen usable with keyboard only (Tab, Enter, Esc); focus ring visible
- [ ] `Ctrl F` focuses the student search; `Ctrl S` saves in exam setup and edit marks
- [ ] Dark mode (Settings → Appearance) on every screen, charts included
- [ ] Window at 1024×680 (minimum): nothing important cut off
- [ ] PIN lock: 5 wrong PINs → 30-second lock
