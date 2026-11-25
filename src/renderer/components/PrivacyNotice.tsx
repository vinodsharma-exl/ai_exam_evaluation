/** Shown once after the first sign-in (and always available in Settings → Privacy). */
import { ShieldCheck } from 'lucide-react';
import { Button, Modal } from './ui';

export function PrivacyText() {
  return (
    <div className="space-y-3 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
      <p>
        <strong>Everything stays on this computer</strong>: profiles, exams, marks and reports are saved as files in your data folder. There is no AnswerEval account and no cloud storage.
      </p>
      <p>
        <strong>Except the AI step.</strong> To read handwriting and recommend marks, page images and answer text are sent to the AI provider <em>you</em> choose in Settings (for example Google Gemini).
      </p>
      <p>
        <strong>Free tiers may use your data.</strong> Free plans such as Google AI Studio's free tier, OpenRouter's free models and Mistral's free plan may keep requests and use them to improve their models. Paid plans usually don't. Check your provider's terms and your institution's rules on student data.
      </p>
      <ul className="list-disc space-y-1 pl-5">
        <li>Use student IDs rather than names on answer sheets where you can.</li>
        <li>Prefer a paid plan, or a provider that does not train on data, for sensitive exams.</li>
        <li>Your API key is encrypted with Windows and never leaves this computer except to call that provider.</li>
      </ul>
      <p className="text-slate-500">AI marks are always shown as <em>Recommended</em>. You review and decide the final marks.</p>
    </div>
  );
}

export function PrivacyNoticeModal({ open, onAccept }: { open: boolean; onAccept: () => void }) {
  return (
    <Modal
      open={open}
      onClose={() => undefined}
      title={
        <span className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-brand-600" /> Before you start: student data and AI
        </span>
      }
      footer={<Button onClick={onAccept}>I understand</Button>}
    >
      <PrivacyText />
    </Modal>
  );
}
