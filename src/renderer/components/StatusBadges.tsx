/** Status pills exactly as in the screenshot: Completed/Good = green, In progress/Partial = orange, Needs review = red. */
import { Sparkles } from 'lucide-react';
import type { StudentStatus } from '../../shared/schemas/student';
import type { QuestionEvaluation } from '../../shared/schemas/evaluation';
import { STUDENT_STATUS_LABEL } from '../lib/format';
import { Badge, type Tone } from './ui';

const STUDENT_TONE: Record<StudentStatus, Tone> = {
  draft: 'gray',
  processing: 'orange',
  paused: 'orange',
  needs_review: 'red',
  evaluated: 'green',
  finalized: 'blue',
  failed: 'red',
};

export function StudentStatusBadge({ status }: { status: StudentStatus }) {
  return <Badge tone={STUDENT_TONE[status]}>{STUDENT_STATUS_LABEL[status]}</Badge>;
}

export function questionVerdict(q: Pick<QuestionEvaluation, 'status' | 'recommendedMarks' | 'maxMarks'>): { label: string; tone: Tone } {
  switch (q.status) {
    case 'needs_review':
      return { label: 'Needs Review', tone: 'red' };
    case 'failed':
      return { label: 'Failed', tone: 'red' };
    case 'pending':
      return { label: 'Pending', tone: 'gray' };
    case 'not_attempted':
      return { label: 'Not attempted', tone: 'gray' };
    default: {
      const ratio = q.maxMarks > 0 ? (q.recommendedMarks ?? 0) / q.maxMarks : 0;
      return ratio >= 0.7 ? { label: 'Good', tone: 'green' } : { label: 'Partial', tone: 'orange' };
    }
  }
}

export function QuestionStatusBadge({ q }: { q: Pick<QuestionEvaluation, 'status' | 'recommendedMarks' | 'maxMarks'> }) {
  const v = questionVerdict(q);
  return <Badge tone={v.tone}>{v.label}</Badge>;
}

const FLAG_TEXT: Record<string, string> = {
  low_confidence: 'Low confidence',
  illegible_text: 'Illegible text',
  diagram_not_assessed: 'Diagram not assessed',
  marks_clamped: 'AI exceeded limit',
  answer_changed_since_evaluation: 'Text edited',
  possible_wrong_question_number: 'Check Q number',
  manual_text: 'Typed text',
  model_flagged: 'AI unsure',
};
export function FlagChips({ flags }: { flags: string[] }) {
  if (!flags.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <Badge key={f} tone={f === 'manual_text' ? 'gray' : 'orange'}>
          {FLAG_TEXT[f] ?? f}
        </Badge>
      ))}
    </span>
  );
}

/** Every AI number carries this label. The professor has the final say. */
export function RecommendedTag({ className }: { className?: string }) {
  return (
    <span title="AI recommendation. You decide the final marks." className={`inline-flex items-center gap-1 text-[11px] font-medium text-violet-600 dark:text-violet-300 ${className ?? ''}`}>
      <Sparkles className="h-3 w-3" /> Recommended
    </span>
  );
}

export function ConfidenceText({ value }: { value: number | null }) {
  if (value === null) return <span className="text-slate-400">—</span>;
  const pct = Math.round(value * 100);
  return <span className={pct < 60 ? 'font-medium text-red-600' : pct < 75 ? 'text-amber-600' : 'text-slate-600 dark:text-slate-300'}>{pct}%</span>;
}
