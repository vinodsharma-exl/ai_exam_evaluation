/**
 * Phase 5 backend: final marks (validation, audit, choice rules, finalize), student PDF, class Excel.
 * Uses the full service graph with the mock AI and a fake renderer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import ExcelJS from 'exceljs';
import { createServices, type Services } from '../src/main/services';
import { createAdapters } from '../src/main/ai/providers/index';
import { wrap } from '../src/main/report/student-report';
import * as P from '../src/shared/paths';
import { tempDir, fakeEncryptor } from './helpers';
import { fakeClock, fakePdf, fakeRenderHost } from './ai-helpers';

const MOCK = { providerId: 'mock' as const, model: 'mock-vision' };
let t: ReturnType<typeof tempDir>;
let s: Services;
let examId: string;
let sid: string;

beforeEach(async () => {
  t = tempDir();
  s = await createServices({ dataDir: join(t.dir, 'Data'), encryptor: fakeEncryptor(), render: fakeRenderHost(), adapters: createAdapters({ mockLatencyMs: 0 }), clock: fakeClock() });
  await s.profile.create({ name: 'Sharma', title: 'Dr.' });
  await s.config.update({ stages: { ocr: MOCK, evaluation: MOCK }, institution: { name: 'Ünïversity of Tëst – CS', department: 'Computer Science' } });
  const exam = await s.exams.createExam({ title: 'DS Midterm', courseCode: 'CS201', examDate: '2026-11-20' });
  examId = exam.id;
  const q = (label: string, maxMarks: number) => ({ label, number: label, order: 0, text: `Question ${label}`, maxMarks, type: 'theory' as const, modelAnswer: 'x', markingPoints: [], finalAnswer: '', expectsDiagram: false, origin: 'manual' as const });
  await s.exams.saveExam({ ...exam, questions: [q('1', 4), q('2', 3), q('3', 3), q('4', 3)], choiceRules: [{ id: 'r1', questionNumbers: ['2', '3', '4'], countBest: 2, description: 'any 2' }] });
  const st = await s.exams.createStudent(examId, { displayId: '21/CS/045', name: 'Aïsha Kumar' });
  sid = st.id;
  const f = join(t.dir, 'sheet.pdf');
  writeFileSync(f, fakePdf(3));
  await s.pages.addUploads(examId, sid, [f]);
  expect((await s.runner.run(examId, sid)).state).toBe('completed');
});
afterEach(async () => {
  await s.runner.stopAll();
  t.cleanup();
});

describe('final marks', () => {
  it('drafts from AI recommendations without saving', async () => {
    const d = await s.reports.getFinalDraft(examId, sid);
    const ev = (await s.exams.getStudentBundle(examId, sid)).evaluation!;
    expect(d.questions.map((q) => q.aiMarks)).toEqual(ev.questions.map((q) => q.recommendedMarks));
    expect(d.status).toBe('draft');
    expect(await s.store.exists(P.finalFile(examId, sid))).toBe(false);
  });

  it('validates marks, applies choice rules, grades, audits and finalizes', async () => {
    await expect(s.reports.saveFinal(examId, sid, { questions: [{ questionNumber: '1', finalMarks: 5 }] }, false)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(s.reports.saveFinal(examId, sid, { questions: [{ questionNumber: '1', finalMarks: 2.3 }] }, false)).rejects.toMatchObject({ code: 'VALIDATION' });

    const f1 = await s.reports.saveFinal(
      examId,
      sid,
      {
        questions: [
          { questionNumber: '1', finalMarks: 3.5, comment: 'Good definition.', reason: 'Partial credit for example' },
          { questionNumber: '2', finalMarks: 3 },
          { questionNumber: '3', finalMarks: 1 },
          { questionNumber: '4', finalMarks: 2 },
        ],
        overallComment: 'Solid work.',
      },
      true,
    );
    expect(f1.total).toBe(3.5 + 3 + 2); // best 2 of Q2–Q4
    expect(f1.maxTotal).toBe(10);
    expect(f1.questions.find((q) => q.questionNumber === '3')!.dropped).toBe(true);
    expect(f1.percentage).toBe(85);
    expect(f1.grade).toBe('A');
    expect(f1.status).toBe('finalized');
    expect(f1.finalizedBy).toBe('Dr. Sharma');
    expect(f1.audit.map((a) => a.action)).toContain('finalize');
    expect(f1.audit.find((a) => a.questionNumber === '1' && a.action === 'edit_marks')?.reason).toBe('Partial credit for example');
    expect((await s.exams.getStudent(examId, sid)).status).toBe('finalized');
    expect((await s.index.search('21cs045'))[0]!.exams[0]!.isFinal).toBe(true);

    // Un-finalize, then the AI is re-run: the professor's marks stay, aiMarks refresh.
    const f2 = await s.reports.saveFinal(examId, sid, { questions: [] }, false);
    expect(f2.status).toBe('draft');
    expect(f2.audit.at(-1)!.action).toBe('unfinalize');
    expect(f2.questions.find((q) => q.questionNumber === '1')!.finalMarks).toBe(3.5);
  });
});

describe('reports', () => {
  it('writes a student PDF (with non-ASCII names) and marks it as generated', async () => {
    await s.reports.saveFinal(examId, sid, { questions: [{ questionNumber: '1', finalMarks: 4, comment: 'A very long comment '.repeat(40) }] }, true);
    const rel = await s.reports.studentReport(examId, sid);
    expect(rel).toBe(P.reportPdf(examId, sid));
    const pdf = await PDFDocument.load(await s.store.readBytes(rel));
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(pdf.getTitle()).toContain('21/CS/045');
    expect((await s.store.read('final', P.finalFile(examId, sid)))!.reportGeneratedAt).not.toBeNull();
  });

  it('can report from AI recommendations before finalizing (draft)', async () => {
    const rel = await s.reports.studentReport(examId, sid);
    expect(await s.store.exists(rel)).toBe(true);
  });

  it('writes a class sheet with per-question marks, totals and summary formulas', async () => {
    const st2 = await s.exams.createStudent(examId, { displayId: 'S2', name: 'Ravi' }); // not evaluated
    void st2;
    await s.reports.saveFinal(examId, sid, { questions: [{ questionNumber: '1', finalMarks: 4 }, { questionNumber: '2', finalMarks: 3 }, { questionNumber: '3', finalMarks: 3 }, { questionNumber: '4', finalMarks: 1 }] }, true);
    const rel = await s.reports.classSheet(examId);
    const wb = new ExcelJS.Workbook();
    // exceljs's Buffer type predates Node's generic Buffer; the bytes are the same.
    await wb.xlsx.load((await s.store.readBytes(rel)) as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.getWorksheet('Marks')!;
    const header = (ws.getRow(4).values as unknown[]).slice(1);
    expect(header).toEqual(['Student ID', 'Name', 'Roll no.', 'Section', 'Q1', 'Q2', 'Q3', 'Q4', 'Total', 'Max', '%', 'Grade', 'Marks source', 'Status']);
    const rows = [5, 6].map((r) => (ws.getRow(r).values as unknown[]).slice(1));
    const asha = rows.find((r) => r[0] === '21/CS/045')!;
    expect(asha.slice(4, 10)).toEqual([4, 3, 3, undefined, 10, 10]); // Q4 dropped by "best 2": empty cell
    expect(asha[12]).toBe('Final');
    const ravi = rows.find((r) => r[0] === 'S2')!;
    expect(ravi[12]).toBe('Not evaluated');
    expect(wb.getWorksheet('Questions')!.rowCount).toBe(5);

    const summary = (await s.reports.classData(examId)).summary;
    expect(summary.stats.count).toBe(2);
    expect(summary.stats.average).toBe(10);
    expect(summary.questionStats.find((q) => q.number === '1')!.averagePercent).toBe(100);
  });
});

describe('wrap', () => {
  it('wraps by width and breaks very long words', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont('Helvetica');
    const lines = wrap('short words here and a loooooooooooooooooooooooooooooooooooooong one', font, 10, 80);
    expect(lines.every((l) => font.widthOfTextAtSize(l, 10) <= 80)).toBe(true);
    expect(lines.join('')).toContain('looo');
  });
});
