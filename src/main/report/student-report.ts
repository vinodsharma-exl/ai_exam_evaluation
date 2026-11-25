/**
 * Student report PDF (A4): header, student details, total with percentage and grade, a question-wise
 * table with marks and feedback, the overall comment, and a footer that says AI assisted and the
 * professor reviewed. A report that isn't finalized carries a "DRAFT" watermark.
 *
 * Fonts: Windows' own Arial (embedded with fontkit) covers Latin, Greek and Cyrillic. If it's missing,
 * Helvetica is used and characters it can't encode become '?', so generation never fails on a name.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { ExamFile } from '../../shared/schemas/exam';
import type { StudentFile } from '../../shared/schemas/student';
import type { FinalFile } from '../../shared/schemas/final';
import type { EvaluationFile } from '../../shared/schemas/evaluation';
import type { ConfigFile } from '../../shared/schemas/config';

export interface ReportInput {
  exam: ExamFile;
  student: StudentFile;
  final: FinalFile;
  evaluation: EvaluationFile | null;
  config: ConfigFile;
  professor: string;
  generatedAt: Date;
  /** Optional logo bytes (PNG/JPG) from Settings. */
  logo?: { bytes: Uint8Array; kind: 'png' | 'jpg' } | null;
}

const A4: [number, number] = [595.28, 841.89];
const M = 48; // margin
const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.42, 0.45, 0.5);
const LINE = rgb(0.86, 0.88, 0.91);
const NAVY = rgb(0.06, 0.106, 0.176);
const BRAND = rgb(0.114, 0.357, 0.941);

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  /** Makes text safe for the font (only needed for the Helvetica fallback). */
  safe: (s: string) => string;
}

async function loadFonts(pdf: PDFDocument): Promise<Fonts> {
  const dir = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts');
  const reg = join(dir, 'arial.ttf');
  const bold = join(dir, 'arialbd.ttf');
  if (existsSync(reg) && existsSync(bold)) {
    pdf.registerFontkit(fontkit);
    return {
      regular: await pdf.embedFont(readFileSync(reg), { subset: true }),
      bold: await pdf.embedFont(readFileSync(bold), { subset: true }),
      safe: (s) => s.replace(/[\u0000-\u0008\u000b-\u001f]/g, ''),
    };
  }
  return {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    // WinAnsi only: replace anything outside Latin-1 (plus the usual typographic marks).
    safe: (s) => s.replace(/[^\n\x20-\x7e\xa0-\xff\u2013\u2014\u2018\u2019\u201c\u201d\u2022\u2026]/g, '?'),
  };
}

/** Greedy word wrap by measured width. Long words are broken by character. */
export function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r/g, '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const trial = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(trial, size) <= width) {
        line = trial;
        continue;
      }
      if (line) out.push(line);
      if (font.widthOfTextAtSize(word, size) <= width) {
        line = word;
      } else {
        let chunk = '';
        for (const ch of word) {
          if (font.widthOfTextAtSize(chunk + ch, size) > width) {
            out.push(chunk);
            chunk = ch;
          } else chunk += ch;
        }
        line = chunk;
      }
    }
    out.push(line);
  }
  return out;
}

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ''));

export async function buildStudentReport(r: ReportInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${r.exam.title}: ${r.student.displayId}`);
  pdf.setAuthor(r.professor);
  pdf.setCreator('AnswerEval AI');
  pdf.setProducer('AnswerEval AI');
  pdf.setCreationDate(r.generatedAt);
  const f = await loadFonts(pdf);
  const draft = r.final.status !== 'finalized';
  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;

  const text = (s: string, x: number, yy: number, size: number, opts: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}) =>
    page.drawText(f.safe(s), { x, y: yy, size, font: opts.bold ? f.bold : f.regular, color: opts.color ?? INK });

  const newPage = () => {
    page = pdf.addPage(A4);
    pages.push(page);
    y = A4[1] - M;
    if (draft) {
      page.drawText('DRAFT: NOT FINALIZED', { x: 120, y: 300, size: 46, font: f.bold, color: rgb(0.93, 0.35, 0.35), opacity: 0.12, rotate: degrees(35) });
    }
  };
  const ensure = (h: number) => {
    if (y - h < M + 30) {
      newPage();
      tableHeader();
    }
  };

  newPage();

  // ---- Header band
  page.drawRectangle({ x: 0, y: A4[1] - 96, width: A4[0], height: 96, color: NAVY });
  let hx = M;
  if (r.logo) {
    try {
      const img = r.logo.kind === 'png' ? await pdf.embedPng(r.logo.bytes) : await pdf.embedJpg(r.logo.bytes);
      const h = 48;
      const w = (img.width / img.height) * h;
      page.drawImage(img, { x: M, y: A4[1] - 72, width: w, height: h });
      hx = M + w + 14;
    } catch {
      /* a broken logo never blocks the report */
    }
  }
  const inst = r.config.institution;
  text(inst.name || 'Student Answer Evaluation Report', hx, A4[1] - 44, 16, { bold: true, color: rgb(1, 1, 1) });
  text([inst.department, r.exam.className].filter(Boolean).join(' · ') || 'Answer sheet evaluation', hx, A4[1] - 64, 10, { color: rgb(0.75, 0.8, 0.88) });
  y = A4[1] - 96 - 30;

  // ---- Exam and student details
  text(r.exam.title, M, y, 18, { bold: true });
  y -= 18;
  const examLine = [r.exam.courseCode, r.exam.subject, r.exam.examDate ? new Date(`${r.exam.examDate}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : ''].filter(Boolean).join('  ·  ');
  if (examLine) {
    text(examLine, M, y, 10, { color: MUTED });
    y -= 14;
  }
  y -= 12;

  const boxTop = y;
  const details: Array<[string, string]> = [
    ['Student ID', r.student.displayId],
    ['Name', r.student.name || '—'],
    ['Roll no.', r.student.rollNo || '—'],
    ['Section', r.student.section || '—'],
  ];
  details.forEach(([k, v], i) => {
    const yy = boxTop - i * 18;
    text(k, M, yy, 10, { color: MUTED });
    text(v, M + 80, yy, 11, { bold: i < 2 });
  });

  // Total card (right)
  const cardW = 190;
  const cx = A4[0] - M - cardW;
  page.drawRectangle({ x: cx, y: boxTop - 62, width: cardW, height: 82, borderColor: LINE, borderWidth: 1, color: rgb(0.97, 0.98, 1) });
  text('Total marks', cx + 14, boxTop + 2, 10, { color: MUTED });
  const totalStr = `${fmt(r.final.total)} / ${fmt(r.final.maxTotal)}`;
  text(totalStr, cx + 14, boxTop - 28, 26, { bold: true, color: NAVY });
  text(`${fmt(r.final.percentage)}%${r.final.grade ? `   ·   Grade ${r.final.grade}` : ''}`, cx + 14, boxTop - 48, 11, { bold: true, color: BRAND });
  y = boxTop - 4 * 18 - 22;

  // ---- Question table
  const cols = { q: M, max: M + 52, marks: M + 100, fb: M + 160 };
  const fbWidth = A4[0] - M - cols.fb;
  /** Header band whose top is at y; afterwards y is the top of the first row. */
  function tableHeader() {
    const h = 22;
    page.drawRectangle({ x: M, y: y - h, width: A4[0] - 2 * M, height: h, color: rgb(0.95, 0.96, 0.98) });
    const base = y - 15;
    text('Q. No.', cols.q + 6, base, 9, { bold: true, color: MUTED });
    text('Max', cols.max, base, 9, { bold: true, color: MUTED });
    text('Marks', cols.marks, base, 9, { bold: true, color: MUTED });
    text('Feedback', cols.fb, base, 9, { bold: true, color: MUTED });
    y -= h;
  }
  tableHeader();

  for (const fq of r.final.questions) {
    const q = r.exam.questions.find((x) => x.number === fq.questionNumber);
    const ev = r.evaluation?.questions.find((x) => x.questionNumber === fq.questionNumber);
    const fbParts = [fq.comment.trim()];
    if (ev?.status === 'not_attempted' && !fq.comment.trim()) fbParts.push('Not attempted.');
    if (fq.dropped) fbParts.push('(Not counted: "answer any" rule, a better answer was counted.)');
    const lines = wrap(fbParts.filter(Boolean).join(' ') || '—', f.regular, 9.5, fbWidth);
    // Row box: top = y, first baseline 15pt below, 12.5pt line pitch, 8pt bottom padding.
    const rowH = Math.max(24, 15 + (lines.length - 1) * 12.5 + 9);
    ensure(rowH);
    const base = y - 15;
    text(q?.label ?? fq.questionNumber, cols.q + 6, base, 10.5, { bold: true });
    text(fmt(fq.maxMarks), cols.max, base, 10.5, { color: MUTED });
    text(fmt(fq.finalMarks), cols.marks, base, 10.5, { bold: true, color: fq.dropped ? MUTED : INK });
    lines.forEach((l, i) => text(l, cols.fb, base - i * 12.5, 9.5));
    y -= rowH;
    page.drawLine({ start: { x: M, y }, end: { x: A4[0] - M, y }, thickness: 0.5, color: LINE });
  }

  // ---- Overall comment
  if (r.final.overallComment.trim()) {
    const lines = wrap(r.final.overallComment, f.regular, 10.5, A4[0] - 2 * M);
    ensure(30 + lines.length * 14);
    y -= 10;
    text('Overall comment', M, y, 11, { bold: true });
    y -= 16;
    for (const l of lines) {
      ensure(14);
      text(l, M, y, 10.5);
      y -= 14;
    }
  }

  // ---- Footers on every page
  const stamp = r.generatedAt.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const statusText = draft ? 'Draft: marks not yet finalized' : `Finalized by ${r.final.finalizedBy ?? r.professor}`;
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: M + 6 }, end: { x: A4[0] - M, y: M + 6 }, thickness: 0.5, color: LINE });
    p.drawText(f.safe(`Evaluated with AI assistance and reviewed by ${r.professor}. ${statusText}. Generated ${stamp}.`), { x: M, y: M - 8, size: 7.5, font: f.regular, color: MUTED });
    p.drawText(`Page ${i + 1} of ${pages.length}`, { x: A4[0] - M - 50, y: M - 8, size: 7.5, font: f.regular, color: MUTED });
  });

  return pdf.save();
}
