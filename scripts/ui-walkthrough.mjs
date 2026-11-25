/**
 * End-to-end UI walkthrough with the offline mock AI (no key, no network). Exercises every screen:
 * profile → privacy → settings (mock models) → exam setup (AI proposal from pasted text) → wizard
 * upload → estimate → processing → results → question detail → edit marks → finalize → PDF report
 * → class charts (6 students) → student search → dashboard.
 *
 * Uses a throwaway profile and data folder in %TEMP%; screenshots are saved for review.
 *   npm run test:ui                          # dev build (out/)
 *   node scripts/ui-walkthrough.mjs --exe "C:\Users\me\AppData\Local\Programs\AnswerEval AI\AnswerEval AI.exe"
 *
 * Exit code 0 = every step passed. Note: native file dialogs and drag & drop can't be scripted, so uploads
 * go through the same IPC call the drop zone uses.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { launch, sleep } from './lib/cdp.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const exeArg = process.argv.indexOf('--exe');
const exe = exeArg > 0 ? process.argv[exeArg + 1] : join(ROOT, 'node_modules/electron/dist/electron.exe');
const appDir = exeArg > 0 ? null : ROOT;
const sheet = join(ROOT, 'samples', 'answer_sheet_S001.pdf').replace(/\\/g, '/');
if (!existsSync(sheet)) execSync('npx tsx scripts/make-samples.ts', { cwd: ROOT, stdio: 'inherit' });

const base = join(tmpdir(), 'answereval-ui-walkthrough');
rmSync(base, { recursive: true, force: true });
const userData = join(base, 'userData');
mkdirSync(userData, { recursive: true });
writeFileSync(join(userData, 'bootstrap.json'), JSON.stringify({ dataDir: join(base, 'Data') }));
const shots = join(base, 'screenshots');

const page = await launch({ exe, appDir, userData });
let failed = false;
const step = async (name, fn) => {
  try {
    await fn();
    await page.shot(shots, name);
    console.log('ok  ', name);
  } catch (e) {
    failed = true;
    await page.shot(shots, `${name}-FAILED`).catch(() => {});
    console.log('FAIL', name, '-', e.message);
    throw e;
  }
};

try {
  await step('01-welcome', () => page.waitText('Create your local profile'));
  await step('02-privacy-notice', async () => {
    await page.fill('input[aria-label="Name"]', 'Sharma');
    await page.fill('input[aria-label="Department"]', 'Computer Science');
    await page.click('Get started');
    await page.waitText('student data and AI');
  });
  await step('03-dashboard', async () => {
    await page.click('I understand');
    await page.waitText('Start New Evaluation');
  });
  await step('04-settings-models', async () => {
    await page.click('Settings', { exact: true });
    await page.waitText('Stage A');
    for (let i = 0; i < 2; i++) {
      await page.eval(`(() => { const s = [...document.querySelectorAll('select')].filter(x => [...x.options].some(o => o.value === 'mock'))[${i}];
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'mock'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(200);
    }
    await page.click('Save', { exact: true });
    await page.waitText('Reading model saved');
    await page.click('Save', { exact: true });
    await page.waitText('Grading model saved');
  });
  await step('05-settings-providers', async () => {
    await page.click('Providers & keys');
    await page.waitText('Models and limits');
  });
  await step('06-new-exam', async () => {
    await page.click('Question Paper & Model', { exact: true });
    await page.click('New exam');
    await page.fill('input[placeholder="e.g. Data Structures Midterm"]', 'Data Structures Midterm');
    await page.fill('input[placeholder="CS201"]', 'CS201');
    await page.click('Create', { exact: true });
    await page.waitText('Question-wise Marks');
  });
  await step('07-question-paper-proposal', async () => {
    await page.click('or paste / type the text', { nth: 0 });
    await page.fill('textarea[placeholder^="Q1 (a) Define"]', 'Q1 (a) Define a stack. [2]\nQ1 (b) Explain push and pop. [3]\nQ2 Queue arithmetic. [5]');
    await page.eval(`[...document.querySelectorAll('[role=dialog] button')].find(b => b.innerText.includes('Read with AI')).click()`);
    await page.waitText('AI proposal from the question paper');
  });
  await step('08-model-answer-saved', async () => {
    await page.click('or paste / type the text', { nth: 1 });
    await page.fill('textarea[placeholder^="Q1 (a) A stack is a LIFO"]', 'Q1(a) LIFO structure. Q1(b) push/pop at top. Q2 5-3 = 2 items.');
    await page.eval(`[...document.querySelectorAll('[role=dialog] button')].find(b => b.innerText.includes('Read with AI')).click()`);
    await page.waitText('AI proposal from the model answers');
    await page.click('Save exam template');
    await page.waitText('Exam saved and ready');
  });
  const examId = await page.eval(`window.api.listExams().then(r => r.data[0].id)`);
  await step('09-wizard-student', async () => {
    await page.click('Evaluate Answer Sheet', { exact: true });
    await page.waitText('Which exam is this answer sheet for?');
    await page.fill('select', examId);
    await page.fill('input[placeholder="21/CS/045"]', 'S001');
    await page.click('Add', { exact: true });
    await page.waitText('Upload Student Answer Sheet');
  });
  await step('10-wizard-pages', async () => {
    const sid = await page.eval(`window.api.listStudents(${JSON.stringify(examId)}).then(r => r.data[0].id)`);
    const ok = await page.eval(`window.api.addUploads(${JSON.stringify(examId)}, ${JSON.stringify(sid)}, [${JSON.stringify(sheet)}]).then(r => r.ok)`);
    if (!ok) throw new Error('upload failed');
    await page.click('Change', { exact: true });
    await page.fill('input[placeholder="21/CS/045"]', 'S001');
    await page.click('Add', { exact: true });
    await page.waitText('answer_sheet_S001.pdf');
    await page.waitText('Page 3');
  });
  await step('11-wizard-configure', async () => {
    await page.click('Next', { exact: true });
    await page.waitText('Question-wise Marks');
  });
  await step('12-usage-estimate', async () => {
    await page.click('Next: Process');
    await page.waitText('Before you start');
    await page.waitText('AI request');
  });
  await step('13-processing', async () => {
    await page.click('Start evaluation');
    await page.waitText('Processing Answer Sheet');
  });
  await step('14-results', async () => {
    await page.waitText('Evaluation Results', 30000);
    const total = await page.eval(`document.body.innerText.match(/Total Marks\\s+(\\S+)/)?.[1]`);
    if (!total || total === '0') throw new Error(`Unexpected total: ${total} (pages skipped as blank?)`);
  });
  await step('15-question-detail', async () => {
    await page.eval(`(() => { const row = [...document.querySelectorAll('tbody tr')].find(r => r.innerText.includes('Needs Review')) || document.querySelector('tbody tr'); row.querySelector('button').click(); })()`);
    await page.waitText('AI Evaluation & Feedback');
    await page.waitText('Edit Marks for Q');
  });
  await step('16-original-image', async () => {
    await page.click('Original Answer Image');
    await sleep(800);
  });
  await step('17-edit-mark', async () => {
    await page.click("Student's Answer (Extracted Text)");
    await page.fill('input[aria-label="Final marks"]', '1.5');
    await page.fill('input[placeholder^="e.g. Method correct"]', 'Example incomplete').catch(() => {});
    await page.eval(`[...document.querySelectorAll('button')].filter(b => b.innerText.trim() === 'Save').pop().click()`);
    await page.waitText('saved');
  });
  await step('18-edit-all-marks', async () => {
    await page.eval(`[...document.querySelectorAll('button')].find(b => b.innerText.includes('results')).click()`);
    await page.waitText('Edit All Marks');
    await page.click('Edit All Marks');
    await page.waitText('Audit trail');
  });
  await step('19-finalized', async () => {
    await page.click('Finalize marks');
    await page.waitText('Finalize these marks?');
    await page.eval(`[...document.querySelectorAll('[role=dialog] button')].find(b => b.innerText.trim() === 'Finalize').click()`);
    await page.waitText('Finalized by');
  });
  await step('20-pdf-report', async () => {
    await page.click('Report', { exact: true });
    await page.waitText('Generate & Download Report');
    await page.click('Generate PDF report');
    await page.waitText('Report Generated Successfully');
  });
  // Five more students with varied final marks, so the class charts have data.
  await page.eval(`(async () => {
    const e = ${JSON.stringify(examId)};
    const marks = [[2,3,5],[1,2,3],[2,1.5,4],[0.5,1,2],[2,3,4.5]];
    for (let i = 0; i < marks.length; i++) {
      const st = (await window.api.createStudent(e, { displayId: 'S00' + (i + 2), name: ['Ravi Shah','Meera Iyer','John Dsouza','Fatima Khan','Arjun Rao'][i] })).data;
      await window.api.addUploads(e, st.id, [${JSON.stringify(sheet)}]);
      await window.api.startProcessing(e, st.id);
      for (let k = 0; k < 150; k++) { const b = (await window.api.getStudentBundle(e, st.id)).data; if (b.jobs && b.jobs.state === 'completed') break; await new Promise(r => setTimeout(r, 200)); }
      const ex = (await window.api.getExam(e)).data;
      await window.api.saveFinal(e, st.id, { questions: ex.questions.map((q, j) => ({ questionNumber: q.number, finalMarks: marks[i][j] })) }, i % 2 === 0);
    }
  })()`);
  await step('21-class-charts', async () => {
    await page.click('Reports', { exact: true });
    await page.waitText('Average score per question');
    await page.eval(`document.querySelector('main').scrollTo(0, 420)`);
  });
  await step('22-chart-tooltip', async () => {
    await page.eval(`[...document.querySelectorAll('svg g[tabindex]')][7].focus()`);
    await page.waitText('students');
  });
  await step('23-class-excel', async () => {
    const rel = await page.eval(`window.api.generateClassSheet(${JSON.stringify(examId)}).then(r => r.ok ? r.data : null)`);
    if (!rel) throw new Error('class sheet failed');
  });
  await step('24-student-search', async () => {
    await page.fill('input[aria-label="Search students"]', 's001');
    await page.eval(`document.querySelector('input[aria-label="Search students"]').form.requestSubmit()`);
    await page.waitText('Student Results');
  });
  await step('25-dashboard', async () => {
    await page.click('Dashboard', { exact: true });
    await page.waitText('Recent Evaluations');
  });
} catch {
  /* reported above */
} finally {
  page.close();
}
console.log(failed ? '\nUI walkthrough FAILED' : '\nUI walkthrough passed');
console.log(`Screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
