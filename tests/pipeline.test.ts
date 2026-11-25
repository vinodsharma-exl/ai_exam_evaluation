/**
 * End-to-end pipeline with the offline mock provider, a fake renderer and virtual time:
 * exam setup → upload → OCR → merge → grading → totals, plus resume, quota, re-runs and manual entry.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServices, type Services } from '../src/main/services';
import { createAdapters } from '../src/main/ai/providers/index';
import { estimateUsage } from '../src/main/ai/estimator';
import { groupFilesByStudent } from '../src/main/pages/page-service';
import { addRerunTasks } from '../src/main/jobs/job-logic';
import { newTask } from '../src/main/jobs/job-planner';
import * as P from '../src/shared/paths';
import { tempDir, fakeEncryptor } from './helpers';
import { fakeClock, fakePdf, fakeRenderHost } from './ai-helpers';

const MOCK = { providerId: 'mock' as const, model: 'mock-vision' };
let t: ReturnType<typeof tempDir>;
let s: Services;
let render: ReturnType<typeof fakeRenderHost>;
let examId: string;

async function used(): Promise<number> {
  return s.ledger.usedToday('mock:mock-vision', 'mock');
}

beforeEach(async () => {
  t = tempDir();
  render = fakeRenderHost({ blankPages: [3] }); // the 4th page of each sheet is blank
  s = await createServices({
    dataDir: join(t.dir, 'Data'),
    encryptor: fakeEncryptor(),
    render,
    adapters: createAdapters({ mockLatencyMs: 0 }),
    clock: fakeClock(),
  });
  await s.config.update({ stages: { ocr: MOCK, evaluation: MOCK } });

  const exam = await s.exams.createExam({ title: 'DS Midterm' });
  examId = exam.id;
  const qp = join(t.dir, 'qp.pdf');
  writeFileSync(qp, fakePdf(1));
  await s.sources.attach(examId, 'questionPaper', [qp]);
  const proposal = await s.sources.extract(examId, 'questionPaper', { signal: new AbortController().signal });
  expect(proposal.route).toBe('vision');
  expect(proposal.questions.map((q) => q.number)).toEqual(['1a', '1b', '2']);
  await s.exams.saveExam({ ...(await s.exams.getExam(examId)), questions: proposal.questions });
  const ma = await s.sources.extract(examId, 'modelAnswer', { signal: new AbortController().signal, pastedText: 'Q1(a) LIFO...\nQ1(b) push/pop...\nQ2 2 items' });
  expect(ma.route).toBe('pasted-text');
  const { exam: ready, problems } = await s.exams.saveExam({ ...(await s.exams.getExam(examId)), questions: ma.questions });
  expect(problems).toEqual([]);
  expect(ready.status).toBe('ready');
  expect(ready.totalMarks).toBe(10);
});
afterEach(async () => {
  await s.runner.stopAll();
  t.cleanup();
});

async function addStudent(id: string, pages = 4) {
  const st = await s.exams.createStudent(examId, { displayId: id, name: `Student ${id}` });
  const f = join(t.dir, `${P.toSafeId(id)}.pdf`);
  writeFileSync(f, fakePdf(pages));
  await s.pages.addUploads(examId, st.id, [f]);
  return st.id;
}

describe('pipeline (mock provider)', () => {
  it('uploads, skips blank pages, reads, merges, grades and totals', async () => {
    const before = await used();
    const sid = await addStudent('21/CS/045');
    const ext0 = await s.pages.getExtraction(examId, sid);
    expect(ext0.pages.map((p) => p.ocr.status)).toEqual(['pending', 'pending', 'pending', 'blank']);
    expect(await s.store.exists(P.submissionPdf(examId, sid))).toBe(true);

    const est = await estimateUsage(s, [{ examId, studentId: sid }]);
    // OCR: pages 1-3 in one request (blank page 4 is never sent); evaluation: 3 questions in 1 batch.
    expect(est.byStage).toEqual({ ocr: 1, evaluation: 1 });

    const job = await s.runner.run(examId, sid);
    expect(job.state).toBe('completed');
    expect((await used()) - before).toBe(2);

    const b = await s.exams.getStudentBundle(examId, sid);
    expect(b.extraction!.answers.map((a) => a.questionNumber).sort()).toEqual(['1a', '1b', '2']);
    expect(b.evaluation!.questions.every((q) => q.recommendedMarks !== null && q.recommendedMarks <= q.maxMarks)).toBe(true);
    expect(b.evaluation!.totals.max).toBe(10);
    expect(b.evaluation!.totals.recommended).toBeGreaterThan(0);
    expect(['evaluated', 'needs_review']).toContain(b.student.status);
    expect((await s.index.search('21cs045'))[0]?.exams[0]?.total).toBe(b.evaluation!.totals.recommended);

    // Running again costs nothing.
    await s.runner.run(examId, sid);
    expect((await used()) - before).toBe(2);
  });

  it('pauses at the daily cap and resumes later without re-billing finished work', async () => {
    const sid = await addStudent('S1');
    const before = await used(); // exam setup above already used some of today's quota
    await s.config.updateModelCapabilities(MOCK, { dailyLimit: before + 1 });
    const paused = await s.runner.run(examId, sid);
    expect(paused.state).toBe('paused');
    expect(paused.pauseReason).toBe('rate_limit_daily');
    expect((await used()) - before).toBe(1);

    await s.config.updateModelCapabilities(MOCK, { dailyLimit: null });
    const done = await s.runner.run(examId, sid);
    expect(done.state).toBe('completed');
    expect((await used()) - before).toBe(2); // OCR before the pause + grading after; nothing repeated
  });

  it('re-run OCR for one page and re-evaluate one question cost exactly one request each', async () => {
    const sid = await addStudent('S2');
    await s.runner.run(examId, sid);
    const before = await used();

    await s.store.update('extraction', P.extractionFile(examId, sid), (cur) => ({
      ...cur!,
      pages: cur!.pages.map((p) => (p.index === 2 ? { ...p, ocr: { ...p.ocr, status: 'pending' as const } } : p)),
    }));
    await s.jobs.mutate(examId, sid, (j) =>
      addRerunTasks(j, [newTask({ id: 'ocr:3#rerun', kind: 'ocr_pages', pages: [2], bypassCache: true, reason: 'rerun' }), newTask({ id: 'merge#rerun', kind: 'merge_answers', reason: 'rerun' })], new Date().toISOString()),
    );
    await s.runner.run(examId, sid);
    expect((await used()) - before).toBe(1); // same text → no re-grading needed

    await s.jobs.mutate(examId, sid, (j) =>
      addRerunTasks(j, [newTask({ id: 'eval:2#reeval', kind: 'evaluate_questions', questions: ['2'], bypassCache: true, reason: 'reevaluate' })], new Date().toISOString()),
    );
    await s.runner.run(examId, sid);
    expect((await used()) - before).toBe(2);
    const q2 = (await s.exams.getStudentBundle(examId, sid)).evaluation!.questions.find((q) => q.questionNumber === '2')!;
    expect(q2.history.length).toBe(1); // the earlier recommendation is kept
  });

  it('works without a vision model: pause, then manual page text', async () => {
    await s.config.update({ stages: { ocr: { providerId: 'groq', model: 'llama-3.3-70b-versatile' } } });
    const sid = await addStudent('S3', 2);
    const paused = await s.runner.run(examId, sid);
    expect(paused.pauseReason).toBe('no_vision_model');

    await s.pages.setManualPageText(examId, sid, 0, 'Q1(a) A stack is LIFO\nQ1(b) push and pop');
    await s.pages.setManualPageText(examId, sid, 1, 'Q2 5 - 3 = 2 items');
    const done = await s.runner.run(examId, sid);
    expect(done.state).toBe('completed');
    const b = await s.exams.getStudentBundle(examId, sid);
    expect(b.extraction!.answers.find((a) => a.questionNumber === '2')!.text).toBe('5 - 3 = 2 items');
    expect(b.evaluation!.questions.every((q) => q.status !== 'pending')).toBe(true);
  });

  it('editing an answer flags the evaluation as changed (no automatic request)', async () => {
    const sid = await addStudent('S4');
    await s.runner.run(examId, sid);
    const before = await used();
    const a = await s.pages.saveAnswerText(examId, sid, '1a', 'A stack is a last-in first-out list.');
    expect(a.origin).toBe('ai_edited');
    const q = (await s.exams.getStudentBundle(examId, sid)).evaluation!.questions.find((x) => x.questionNumber === '1a')!;
    expect(q.flags).toContain('answer_changed_since_evaluation');
    expect(q.status).toBe('needs_review');
    expect(await used()).toBe(before);
  });

  it('rotates and deletes pages; rotation re-renders only that page', async () => {
    const sid = await addStudent('S5', 3);
    const rendersBefore = render.renders.length;
    const previews = await s.pages.arrangePages(examId, sid, [
      { index: 2, rotation: 0 },
      { index: 0, rotation: 90 },
      { index: 1, rotation: 0, deleted: true },
    ]);
    expect(previews).toHaveLength(2);
    expect(render.renders.length - rendersBefore).toBe(1);
    const ext = await s.pages.getExtraction(examId, sid);
    expect(ext.pages.map((p) => [p.index, p.source.pageInUpload, p.rotation])).toEqual([[0, 2, 0], [1, 0, 90]]);
    expect(await s.store.listFiles(P.pagesDir(examId, sid))).toEqual(['p001.jpg', 'p002.jpg']);
  });
});

describe('bulk upload file names', () => {
  it('groups pages by student id and reads names', () => {
    const g = groupFilesByStudent(['C:/x/21CS045_Asha Kumar_p2.jpg', 'C:/x/21CS045_Asha Kumar_p1.jpg', 'C:/x/21CS046.pdf', 'C:/x/21CS047 - Ravi - page 1.png']);
    expect(g).toEqual([
      { displayId: '21CS045', name: 'Asha Kumar', files: ['C:/x/21CS045_Asha Kumar_p1.jpg', 'C:/x/21CS045_Asha Kumar_p2.jpg'] },
      { displayId: '21CS046', name: '', files: ['C:/x/21CS046.pdf'] },
      { displayId: '21CS047', name: 'Ravi', files: ['C:/x/21CS047 - Ravi - page 1.png'] },
    ]);
  });
});
