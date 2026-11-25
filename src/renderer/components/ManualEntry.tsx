/**
 * Fallback when no vision model is available (or a page was misread): show the page image and let the
 * professor type its text. Lines starting with a question label ("Q1", "2(a)", "Ans 3") begin answers.
 */
import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Keyboard } from 'lucide-react';
import type { ExtractionPage } from '../../shared/schemas/extraction';
import { api, call, errorData } from '../lib/api';
import { useApp } from '../lib/app-context';
import { Badge, Button, Modal, Spinner, Textarea } from './ui';

export function ManualEntryModal({
  open,
  onClose,
  examId,
  studentId,
  pages,
  startPage = 0,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  examId: string;
  studentId: string;
  pages: ExtractionPage[];
  startPage?: number;
  onSaved: () => void;
}) {
  const { toast } = useApp();
  const [i, setI] = useState(startPage);
  const [img, setImg] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const page = pages[i];

  useEffect(() => {
    if (open) setI(startPage);
  }, [open, startPage]);
  useEffect(() => {
    if (!open || !page) return;
    setImg(null);
    setText(page.fragments.map((f) => (f.questionNumber && !f.continued ? `Q${f.questionNumber} ${f.text}` : f.text)).join('\n'));
    void call(api.getPageImage(examId, studentId, page.index)).then(setImg).catch(() => setImg(null));
  }, [open, page?.index]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (next: boolean) => {
    if (!page) return;
    setBusy(true);
    try {
      await call(api.setManualPageText(examId, studentId, page.index, text));
      toast(`Page ${page.index + 1} saved`);
      onSaved();
      if (next && i < pages.length - 1) setI(i + 1);
      else if (next) onClose();
    } catch (e) {
      toast(errorData(e).detail ?? 'Could not save', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={
        <span className="flex items-center gap-2">
          <Keyboard className="h-4 w-4" /> Type page text: page {page ? page.index + 1 : ''} of {pages.length}
        </span>
      }
      footer={
        <>
          <Button variant="ghost" icon={<ChevronLeft className="h-4 w-4" />} disabled={i === 0} onClick={() => setI(i - 1)}>Previous</Button>
          <Button variant="secondary" busy={busy} onClick={() => save(false)}>Save</Button>
          <Button busy={busy} onClick={() => save(true)} icon={<ChevronRight className="h-4 w-4" />}>Save and next</Button>
        </>
      }
    >
      {page && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex max-h-[60vh] items-start justify-center overflow-auto rounded-lg bg-slate-100 p-2 dark:bg-slate-800">
            {img ? <img src={img} alt={`Page ${page.index + 1}`} className="max-w-full" /> : <Spinner />}
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Text on this page</span>
              {page.ocr.status === 'manual' && <Badge tone="gray">typed</Badge>}
              {page.ocr.status === 'done' && <Badge tone="purple">read by AI</Badge>}
            </div>
            <Textarea className="min-h-[45vh] flex-1 font-mono text-[13px]" value={text} onChange={(e) => setText(e.target.value)} placeholder={'Q1 (a) A stack is a last-in, first-out list…\n2. 5 - 3 = 2 items\n\nText before the first label continues the previous page.'} />
            <p className="text-xs text-slate-500">
              Start each answer with its question number (Q1, 2(a), Ans 3). Write <code>[illegible]</code> for words you can't read. This page will not be sent to the AI.
            </p>
          </div>
        </div>
      )}
    </Modal>
  );
}
