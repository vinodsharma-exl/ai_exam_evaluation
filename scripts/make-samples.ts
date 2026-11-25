/**
 * Creates sample inputs for render checks and the offline demo:
 *   samples/question_paper.pdf  typed, 2 pages (page 2 blank → tests blank detection and the text layer)
 *   samples/word.png            "TEST" in block letters (photo path)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { renderWordPng } from '../src/main/ai/probe-image';

const out = join(process.cwd(), 'samples');
mkdirSync(out, { recursive: true });

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
const page = pdf.addPage([595, 842]);
const lines = [
  'Data Structures - Midterm Examination          Total: 10 marks',
  '',
  'Q1 (a) Define a stack and state its main property.            [2]',
  'Q1 (b) Explain push and pop operations with an example.       [3]',
  'Q2     A queue holds 5 items and 3 are removed.',
  '       How many items remain? Show your working.              [5]',
];
lines.forEach((l, i) => page.drawText(l, { x: 50, y: 780 - i * 22, size: 12, font }));
pdf.addPage([595, 842]); // blank
writeFileSync(join(out, 'question_paper.pdf'), await pdf.save());
writeFileSync(join(out, 'word.png'), renderWordPng('TEST'));
// Faint pencil on slightly grey paper: must NOT be detected as a blank page.
writeFileSync(join(out, 'faint_pencil.png'), renderWordPng('TEST', 4, 300, 185, 225));

// A 3-page "answer sheet" for UI walkthroughs with the offline mock provider.
const sheet = await PDFDocument.create();
const sheetFont = await sheet.embedFont(StandardFonts.Helvetica); // fonts belong to one document
const answers = [
  ['Ans 1(a)  A stack is a linear data structure.', 'It follows LIFO: last in, first out.', '', 'Ans 1(b)  push adds an item on top,', 'pop removes the top item.'],
  ['e.g. push(3), push(5), pop() -> 5', '', 'Ans 2  Items left = 5 - 3', '         = 2 items'],
  ['(rough work)  5 - 3 = 2'],
];
for (const pageLines of answers) {
  const pg = sheet.addPage([595, 842]);
  pageLines.forEach((l, i) => pg.drawText(l, { x: 60, y: 760 - i * 30, size: 16, font: sheetFont }));
}
writeFileSync(join(out, 'answer_sheet_S001.pdf'), await sheet.save());
console.log('wrote samples/question_paper.pdf, samples/word.png, samples/answer_sheet_S001.pdf');
