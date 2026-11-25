/**
 * Class sheet (Excel): one row per student with question-wise marks, total, %, grade and where the
 * marks came from (final, draft, or AI recommended); class average/highest/lowest; a second sheet with
 * per-question statistics. Header frozen, filters on, numbers stored as numbers.
 */
import ExcelJS from 'exceljs';
import type { ExamFile } from '../../shared/schemas/exam';
import type { ClassSummary } from '../../shared/ipc';
import { percentage, gradeFor } from '../../shared/grading-math';
import type { ConfigFile } from '../../shared/schemas/config';
import type { StudentMarks } from './class-data';

const SOURCE_LABEL: Record<StudentMarks['source'], string> = {
  final: 'Final',
  final_draft: 'Draft (edited)',
  ai: 'AI recommended',
  none: 'Not evaluated',
};

export async function buildClassSheet(args: {
  exam: ExamFile;
  rows: StudentMarks[];
  summary: ClassSummary;
  config: ConfigFile;
  professor: string;
  generatedAt: Date;
}): Promise<Buffer> {
  const { exam, rows, summary } = args;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AnswerEval AI';
  wb.lastModifiedBy = args.professor;
  wb.created = args.generatedAt;

  // ---------------------------------------------------------------- Marks
  const ws = wb.addWorksheet('Marks', { views: [{ state: 'frozen', ySplit: 4, xSplit: 2 }] });
  const qCols = exam.questions.map((q) => ({ header: `Q${q.label}`, max: q.maxMarks, number: q.number }));
  const headers = ['Student ID', 'Name', 'Roll no.', 'Section', ...qCols.map((q) => q.header), 'Total', 'Max', '%', 'Grade', 'Marks source', 'Status'];

  ws.mergeCells(1, 1, 1, headers.length);
  ws.getCell(1, 1).value = `${exam.title}${exam.courseCode ? ` (${exam.courseCode})` : ''}`;
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  ws.mergeCells(2, 1, 2, headers.length);
  ws.getCell(2, 1).value = `${args.config.institution.name ? `${args.config.institution.name} · ` : ''}Generated ${args.generatedAt.toLocaleString('en-GB')} by ${args.professor}. "AI recommended" marks are not yet reviewed.`;
  ws.getCell(2, 1).font = { italic: true, color: { argb: 'FF666666' } };

  const head = ws.getRow(4);
  head.values = headers;
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  head.height = 30;
  head.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F1B2D' } }));
  // Max marks under each question header.
  const maxRow = ws.getRow(3);
  qCols.forEach((q, i) => {
    const c = maxRow.getCell(5 + i);
    c.value = `max ${q.max}`;
    c.font = { size: 9, color: { argb: 'FF666666' } };
    c.alignment = { horizontal: 'center' };
  });

  let r = 5;
  for (const s of rows) {
    const row = ws.getRow(r++);
    const pct = s.total === null ? null : percentage(s.total, exam.totalMarks);
    row.values = [
      s.student.displayId,
      s.student.name,
      s.student.rollNo,
      s.student.section,
      ...qCols.map((q) => s.perQuestion.get(q.number) ?? null),
      s.total,
      exam.totalMarks,
      pct === null ? null : pct / 100,
      s.grade || (pct === null ? '' : gradeFor(pct, args.config.gradeBands)),
      SOURCE_LABEL[s.source],
      s.needsReview > 0 ? `${s.needsReview} to review` : '',
    ];
    if (s.source === 'ai' || s.needsReview > 0) {
      row.getCell(headers.indexOf('Marks source') + 1).font = { color: { argb: 'FF7C3AED' } };
    }
  }
  const lastData = r - 1;

  // Summary rows (formulas, so they stay right if the professor edits the sheet).
  if (lastData >= 5) {
    r++;
    for (const [label, fn] of [['Average', 'AVERAGE'], ['Highest', 'MAX'], ['Lowest', 'MIN']] as const) {
      const row = ws.getRow(r++);
      row.getCell(2).value = label;
      row.getCell(2).font = { bold: true };
      for (let c = 5; c <= 5 + qCols.length; c++) {
        const col = ws.getColumn(c).letter;
        row.getCell(c).value = { formula: `IFERROR(${fn}(${col}5:${col}${lastData}),"")` };
        row.getCell(c).numFmt = '0.0';
      }
    }
  }

  ws.columns.forEach((col, i) => {
    col.width = i === 1 ? 24 : i < 4 ? 14 : i < 4 + qCols.length ? 9 : 13;
  });
  const pctCol = headers.indexOf('%') + 1;
  ws.getColumn(pctCol).numFmt = '0.0%';
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, lastData), column: headers.length } };

  // ---------------------------------------------------------------- Questions
  const qs = wb.addWorksheet('Questions', { views: [{ state: 'frozen', ySplit: 1 }] });
  qs.columns = [
    { header: 'Question', key: 'label', width: 12 },
    { header: 'Text', key: 'text', width: 60 },
    { header: 'Max marks', key: 'max', width: 11 },
    { header: 'Average', key: 'avg', width: 11 },
    { header: 'Average %', key: 'pct', width: 11 },
    { header: 'Students graded', key: 'n', width: 15 },
  ];
  qs.getRow(1).font = { bold: true };
  for (const st of summary.questionStats) {
    const q = exam.questions.find((x) => x.number === st.number);
    qs.addRow({ label: st.label, text: q?.text ?? '', max: st.maxMarks, avg: st.average, pct: st.averagePercent === null ? null : st.averagePercent / 100, n: st.graded });
  }
  qs.getColumn('pct').numFmt = '0.0%';
  qs.getColumn('avg').numFmt = '0.0';
  qs.getColumn('text').alignment = { wrapText: true, vertical: 'top' };

  // ---------------------------------------------------------------- Distribution
  const ds = wb.addWorksheet('Distribution');
  ds.columns = [
    { header: 'Percentage band', key: 'b', width: 18 },
    { header: 'Students', key: 'c', width: 10 },
  ];
  ds.getRow(1).font = { bold: true };
  for (const d of summary.stats.distribution) ds.addRow({ b: d.bucket, c: d.count });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
