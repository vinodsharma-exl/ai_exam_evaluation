/**
 * Answer-sheet pages for one student: upload (PDF/JPG/PNG, many files), reorder/rotate/delete,
 * normalised page JPEGs + thumbnails, a merged submission.pdf, manual page text and answer edits.
 *
 * Originals are kept in uploads/ so pages can be re-rendered (e.g. after rotating). Rendering runs
 * once per page; blank pages are detected locally and never sent to the AI.
 */
import { promises as fs } from 'node:fs';
import { basename, extname } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { ExtractionFile, ExtractionPage, MergedAnswer } from '../../shared/schemas/extraction';
import type { StudentFile } from '../../shared/schemas/student';
import type { UploadedPagePreview } from '../../shared/ipc';
import { IMAGE_QUALITY_PRESETS } from '../../shared/constants';
import { BLANK_INK_RATIO, type RenderOptions } from '../../shared/render-protocol';
import * as P from '../../shared/paths';
import { AppError } from '../../shared/errors';
import type { FileStore } from '../store/file-store';
import type { ExamRepo } from '../store/exam-repo';
import type { ConfigService } from '../store/config-service';
import type { JobStore } from '../jobs/job-store';
import { addRerunTasks } from '../jobs/job-logic';
import { newTask } from '../jobs/job-planner';
import type { OpenDoc, RenderHost } from '../pdf/render-host';
import { sha256 } from '../ai/response-cache';
import { emptyExtraction, parseManualPageText, textHash } from '../ai/merge-answers';

export type UploadKind = 'pdf' | 'jpg' | 'png';
export type Rotation = 0 | 90 | 180 | 270;
const MAX_FILE_BYTES = 200 * 1024 * 1024;

export function detectKind(bytes: Uint8Array, name: string): UploadKind {
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  const ext = extname(name).toLowerCase();
  if (ext === '.heic' || ext === '.heif') {
    throw new AppError('UNSUPPORTED_FILE', `${basename(name)}: iPhone HEIC photos are not supported. On the phone, set Camera → Formats → "Most Compatible", or export as JPG.`);
  }
  throw new AppError('UNSUPPORTED_FILE', basename(name));
}

export function renderOptions(quality: keyof typeof IMAGE_QUALITY_PRESETS, rotation: Rotation): RenderOptions {
  const q = IMAGE_QUALITY_PRESETS[quality];
  return { dpi: q.dpi, maxLongEdge: q.maxLongEdge, jpegQuality: q.jpegQuality, grayscale: q.grayscale, rotation, thumbLongEdge: 240 };
}

/**
 * Groups files for bulk upload by student ID taken from the file name:
 *   "21CS045.pdf", "21CS045_Asha Kumar.pdf", "21CS045 - Asha Kumar - p2.jpg", "21CS045_page1.jpg"
 * Only explicit page markers (p2, pg2, page 2, (2)) are stripped, never plain trailing digits.
 */
export function groupFilesByStudent(paths: string[]): Array<{ displayId: string; name: string; files: string[] }> {
  const groups = new Map<string, { displayId: string; name: string; files: string[] }>();
  for (const p of paths) {
    let stem = basename(p, extname(p)).trim();
    stem = stem.replace(/[\s_-]*(?:\(\d+\)|(?:p|pg|page)\s*\d+)$/i, '').trim();
    const m = stem.match(/^([^_]+?)(?:\s*[_]\s*|\s+-\s+)(.+)$/);
    const displayId = (m ? m[1]! : stem).trim();
    const name = (m ? m[2]! : '').replace(/[_]+/g, ' ').trim();
    if (!displayId) continue;
    const key = displayId.toLowerCase();
    const g = groups.get(key) ?? { displayId, name, files: [] };
    if (!g.name && name) g.name = name;
    g.files.push(p);
    groups.set(key, g);
  }
  const collator = new Intl.Collator(undefined, { numeric: true });
  return [...groups.values()].map((g) => ({ ...g, files: g.files.sort(collator.compare) }));
}

export class PageService {
  constructor(
    private readonly store: FileStore,
    private readonly exams: ExamRepo,
    private readonly config: ConfigService,
    private readonly jobs: JobStore,
    private readonly render: RenderHost,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private iso() {
    return this.now().toISOString();
  }

  async getExtraction(e: string, s: string): Promise<ExtractionFile> {
    return (await this.store.read('extraction', P.extractionFile(e, s))) ?? emptyExtraction(e, s, [], this.iso());
  }

  /** Renders one page of an already-open document into pages/pNNN.jpg (+ thumbnail). */
  private async renderInto(e: string, s: string, index: number, doc: OpenDoc, pageInUpload: number, uploadIndex: number, rotation: Rotation, tmpPrefix = ''): Promise<ExtractionPage> {
    const quality = (await this.config.get()).imageQuality;
    const r = await doc.render(pageInUpload, renderOptions(quality, rotation));
    const pageRel = P.pageImage(e, s, index);
    const thumbRel = P.pageThumb(e, s, index);
    await this.store.writeBytes(tmpPrefix ? pageRel.replace(/p(\d+)\.jpg$/, `${tmpPrefix}p$1.jpg`) : pageRel, r.jpeg);
    await this.store.writeBytes(tmpPrefix ? thumbRel.replace(/p(\d+)\.jpg$/, `${tmpPrefix}p$1.jpg`) : thumbRel, r.thumb);
    const blank = r.inkRatio < BLANK_INK_RATIO;
    return {
      index,
      file: `pages/p${String(index + 1).padStart(3, '0')}.jpg`,
      source: { uploadIndex, pageInUpload },
      rotation,
      width: r.width,
      height: r.height,
      sha256: sha256(r.jpeg),
      ocr: { status: blank ? 'blank' : 'pending', by: null, cacheKey: null, at: null, error: null },
      fragments: [],
      pageNote: blank ? 'Blank page: skipped (no AI request).' : '',
    };
  }

  /** Adds files after the existing pages. Returns all page previews. */
  async addUploads(e: string, s: string, filePaths: string[]): Promise<UploadedPagePreview[]> {
    const student = await this.exams.getStudent(e, s);
    const ext = await this.getExtraction(e, s);
    const uploads = [...student.uploads];
    const pages = [...ext.pages];
    for (const path of filePaths) {
      const stat = await fs.stat(path);
      if (stat.size > MAX_FILE_BYTES) throw new AppError('UNSUPPORTED_FILE', `${basename(path)} is larger than 200 MB.`);
      const bytes = new Uint8Array(await fs.readFile(path));
      const kind = detectKind(bytes, path);
      const uploadIndex = uploads.length;
      await this.store.writeBytes(P.uploadFile(e, s, uploadIndex, kind), bytes);
      // One open per file; every page renders from the same pdf.js document.
      const pageCount = await this.render.withDocument(bytes, kind === 'pdf' ? 'pdf' : 'image', async (doc) => {
        if (doc.pageCount === 0) throw new AppError('PDF_RENDER_FAILED', `${basename(path)} has no pages.`);
        for (let p = 0; p < doc.pageCount; p++) pages.push(await this.renderInto(e, s, pages.length, doc, p, uploadIndex, 0));
        return doc.pageCount;
      });
      uploads.push({ originalName: basename(path), kind, sha256: sha256(bytes), pageCount });
    }
    await this.saveExtractionPages(e, s, pages);
    await this.exams.updateStudent(e, s, { uploads, status: student.status === 'finalized' ? 'finalized' : 'draft' });
    await this.afterPagesChanged(e, s);
    return this.previews(e, s);
  }

  /**
   * Applies a new page order. Each entry names an existing page index, its absolute rotation, and
   * whether to delete it. Rotated pages are re-rendered from the original upload; others are moved.
   * Text already read from an unrotated page is kept (it's the same image).
   */
  async arrangePages(e: string, s: string, order: Array<{ index: number; rotation: Rotation; deleted?: boolean }>): Promise<UploadedPagePreview[]> {
    const ext = await this.getExtraction(e, s);
    const student = await this.exams.getStudent(e, s);
    const seen = new Set<number>();
    for (const o of order) {
      if (!ext.pages[o.index] || seen.has(o.index)) throw new AppError('VALIDATION', 'Invalid page order');
      seen.add(o.index);
    }
    if (seen.size !== ext.pages.length) throw new AppError('VALIDATION', 'Every page must appear once (mark removed pages as deleted).');

    const keep = order.filter((o) => !o.deleted);
    const TMP = 'new_';
    const next: ExtractionPage[] = [];
    for (const [k, o] of keep.entries()) {
      const old = ext.pages[o.index]!;
      if (o.rotation !== old.rotation) {
        const up = student.uploads[old.source.uploadIndex]!;
        const bytes = new Uint8Array(await this.store.readBytes(P.uploadFile(e, s, old.source.uploadIndex, up.kind)));
        next.push(
          await this.render.withDocument(bytes, up.kind === 'pdf' ? 'pdf' : 'image', (doc) =>
            this.renderInto(e, s, k, doc, old.source.pageInUpload, old.source.uploadIndex, o.rotation, TMP),
          ),
        );
      } else {
        const from = P.pageImage(e, s, old.index);
        const to = P.pageImage(e, s, k).replace(/p(\d+)\.jpg$/, `${TMP}p$1.jpg`);
        await this.store.writeBytes(to, await this.store.readBytes(from));
        const tFrom = P.pageThumb(e, s, old.index);
        if (await this.store.exists(tFrom)) {
          await this.store.writeBytes(P.pageThumb(e, s, k).replace(/p(\d+)\.jpg$/, `${TMP}p$1.jpg`), await this.store.readBytes(tFrom));
        }
        next.push({ ...old, index: k, file: `pages/p${String(k + 1).padStart(3, '0')}.jpg` });
      }
    }
    // Swap: remove the old page files, then move the new ones into place.
    for (const dir of [P.pagesDir(e, s), `${P.pagesDir(e, s)}/thumbs`]) {
      for (const f of await this.store.listFiles(dir)) if (/^p\d+\.jpg$/.test(f)) await this.store.remove(`${dir}/${f}`);
      for (const f of await this.store.listFiles(dir)) {
        if (f.startsWith(TMP)) await fs.rename(this.store.abs(`${dir}/${f}`), this.store.abs(`${dir}/${f.slice(TMP.length)}`));
      }
    }
    await this.saveExtractionPages(e, s, next);
    await this.afterPagesChanged(e, s);
    return this.previews(e, s);
  }

  private async saveExtractionPages(e: string, s: string, pages: ExtractionPage[]): Promise<void> {
    await this.store.update('extraction', P.extractionFile(e, s), (cur) => {
      const base = cur ?? emptyExtraction(e, s, [], this.iso());
      return { ...base, pages, updatedAt: this.iso() };
    });
  }

  /** New page set → rebuild submission.pdf and re-plan the job. Pages already read stay read (no re-billing). */
  private async afterPagesChanged(e: string, s: string): Promise<void> {
    await this.buildSubmissionPdf(e, s);
    await this.jobs.create(e, s);
  }

  async buildSubmissionPdf(e: string, s: string): Promise<void> {
    const ext = await this.getExtraction(e, s);
    const pdf = await PDFDocument.create();
    pdf.setTitle(`Answer sheet ${s}`);
    pdf.setProducer('AnswerEval AI');
    for (const p of ext.pages) {
      const img = await pdf.embedJpg(await this.store.readBytes(P.pageImage(e, s, p.index)));
      // Fit to A4 width at 72 dpi units, keeping the aspect ratio.
      const w = 595;
      const h = (img.height / img.width) * w;
      const page = pdf.addPage([w, h]);
      page.drawImage(img, { x: 0, y: 0, width: w, height: h });
    }
    if (ext.pages.length === 0) {
      await this.store.remove(P.submissionPdf(e, s));
      return;
    }
    await this.store.writeBytes(P.submissionPdf(e, s), await pdf.save());
  }

  async previews(e: string, s: string): Promise<UploadedPagePreview[]> {
    const ext = await this.getExtraction(e, s);
    const student: StudentFile = await this.exams.getStudent(e, s);
    const out: UploadedPagePreview[] = [];
    for (const p of ext.pages) {
      let thumb = '';
      try {
        thumb = `data:image/jpeg;base64,${(await this.store.readBytes(P.pageThumb(e, s, p.index))).toString('base64')}`;
      } catch {
        /* thumbnail missing: UI shows a placeholder */
      }
      out.push({
        index: p.index,
        thumbDataUrl: thumb,
        rotation: p.rotation,
        source: { ...p.source, originalName: student.uploads[p.source.uploadIndex]?.originalName ?? '' },
      });
    }
    return out;
  }

  /**
   * Manual text for one page (no vision model, or the AI misread it). Lines starting with a question
   * label begin that answer. The page is marked 'manual' and is never sent to the AI.
   */
  async setManualPageText(e: string, s: string, pageIndex: number, text: string): Promise<ExtractionPage> {
    const exam = await this.exams.getExam(e);
    const fragments = parseManualPageText(text, exam);
    let updated: ExtractionPage | undefined;
    await this.store.update('extraction', P.extractionFile(e, s), (cur) => {
      if (!cur?.pages[pageIndex]) throw new AppError('NOT_FOUND', `Page ${pageIndex + 1}`);
      const pages = cur.pages.map((p) => {
        if (p.index !== pageIndex) return p;
        updated = {
          ...p,
          fragments,
          ocr: { ...p.ocr, status: 'manual', at: this.iso(), error: null },
          pageNote: 'Text entered manually.',
        };
        return updated;
      });
      return { ...cur, pages, updatedAt: this.iso() };
    });
    await this.requestRemerge(e, s, 'manual');
    return updated!;
  }

  /** Adds "merge → finalize" to a job that already merged, so typed text flows into the answers. */
  async requestRemerge(e: string, s: string, reason: string): Promise<void> {
    const job = await this.jobs.get(e, s);
    if (!job || !job.tasks.some((t) => t.kind === 'merge_answers' && t.status === 'done')) return;
    const id = `merge#${reason}-${this.now().getTime().toString(36)}`;
    await this.jobs.mutate(e, s, (j) => addRerunTasks(j, [newTask({ id, kind: 'merge_answers', reason })], this.iso()));
  }

  /**
   * The professor edits the extracted text of one answer (Question Detail). The evaluation is not
   * re-run automatically; it is flagged so the UI can offer "Re-evaluate" (1 request).
   */
  async saveAnswerText(e: string, s: string, questionNumber: string, text: string): Promise<MergedAnswer> {
    const exam = await this.exams.getExam(e);
    if (!exam.questions.some((q) => q.number === questionNumber)) throw new AppError('NOT_FOUND', `Question ${questionNumber}`);
    let saved!: MergedAnswer;
    await this.store.update('extraction', P.extractionFile(e, s), (cur) => {
      const base = cur ?? emptyExtraction(e, s, [], this.iso());
      const prev = base.answers.find((a) => a.questionNumber === questionNumber);
      saved = {
        questionNumber,
        pages: prev?.pages ?? [],
        text: text.slice(0, 40_000),
        hasDiagram: prev?.hasDiagram ?? false,
        diagramDescription: prev?.diagramDescription ?? '',
        illegibleCount: (text.match(/\[illegible\]/gi) ?? []).length,
        confidence: 1,
        origin: prev ? (prev.origin === 'manual' ? 'manual' : 'ai_edited') : 'manual',
        editedAt: this.iso(),
        textHash: textHash(text + '\u0000' + (prev?.diagramDescription ?? '')),
      };
      const others = base.answers.filter((a) => a.questionNumber !== questionNumber);
      const order = new Map(exam.questions.map((q, i) => [q.number, i]));
      const answers = [...others, saved].sort((a, b) => (order.get(a.questionNumber) ?? 0) - (order.get(b.questionNumber) ?? 0));
      const notAttempted = text.trim() ? base.notAttempted.filter((n) => n !== questionNumber) : base.notAttempted;
      return { ...base, answers, notAttempted, updatedAt: this.iso() };
    });
    await this.store.update('evaluation', P.evaluationFile(e, s), (ev) => {
      if (!ev) return undefined;
      return {
        ...ev,
        questions: ev.questions.map((q) => {
          if (q.questionNumber !== questionNumber || q.answerTextHash === saved.textHash) return q;
          if (q.status === 'pending') return q;
          const flags = q.flags.includes('answer_changed_since_evaluation') ? q.flags : [...q.flags, 'answer_changed_since_evaluation' as const];
          return { ...q, flags, status: 'needs_review' as const };
        }),
        updatedAt: this.iso(),
      };
    });
    return saved;
  }
}
