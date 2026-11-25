/**
 * Screen 1: Login / Welcome (layout from the screenshot). There is no online account: the first run
 * creates a local profile (name and optional PIN); afterwards it unlocks with the PIN.
 */
import { useEffect, useRef, useState } from 'react';
import { Building2, Eye, EyeOff, GraduationCap, KeyRound, User } from 'lucide-react';
import type { ProfilePublic } from '../../shared/ipc';
import { ERROR_INFO, type ErrorCode } from '../../shared/errors';
import { api, call, errorData } from '../lib/api';
import { useApp } from '../lib/app-context';
import { Button, Field, Input, Loading, Select } from '../components/ui';

export function Welcome() {
  const { setProfile } = useApp();
  const [existing, setExisting] = useState<ProfilePublic | null | undefined>(undefined);
  useEffect(() => {
    void call(api.getProfile()).then(setExisting, () => setExisting(null));
  }, []);

  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-slate-100 to-brand-50 p-6 dark:from-slate-950 dark:to-navy-900">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white px-10 py-10 shadow-xl dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-8 text-center">
          <GraduationCap className="mx-auto h-12 w-12 text-navy-900 dark:text-white" />
          <h1 className="mt-3 text-3xl font-bold text-brand-600">AnswerEval AI</h1>
          <p className="mt-1 font-medium text-slate-700 dark:text-slate-200">AI-Assisted Handwritten Answer Evaluation</p>
          <p className="mt-1 text-sm text-slate-500">Upload. Analyze. Evaluate. Simplify Grading.</p>
        </div>
        {existing === undefined ? <Loading /> : existing ? <SignIn profile={existing} onDone={setProfile} /> : <CreateProfile onDone={setProfile} />}
        <p className="mt-8 text-center text-xs text-slate-400">Designed for Teachers | Powered by AI | Data stays local</p>
      </div>
    </div>
  );
}

function message(err: unknown): string {
  const d = errorData(err);
  return d.code === 'VALIDATION' && d.detail ? d.detail : ERROR_INFO[d.code as ErrorCode]?.message ?? 'Something went wrong.';
}

function SignIn({ profile, onDone }: { profile: ProfilePublic; onDone: (p: ProfilePublic) => void }) {
  const [pin, setPin] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      onDone(await call(api.login(profile.hasPin ? pin : undefined)));
    } catch (e) {
      setErr(message(e));
      setPin('');
      ref.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="rounded-lg bg-slate-50 px-4 py-3 text-center dark:bg-slate-800">
        <p className="text-sm text-slate-500">Welcome back</p>
        <p className="text-lg font-semibold">{[profile.title, profile.name].filter(Boolean).join(' ')}</p>
      </div>
      {profile.hasPin && (
        <div className="relative">
          <Input
            ref={ref}
            type={show ? 'text' : 'password'}
            inputMode="numeric"
            autoComplete="off"
            placeholder="Enter your PIN"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
            leading={<KeyRound className="h-4 w-4" />}
            aria-label="PIN"
          />
          <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" aria-label={show ? 'Hide PIN' : 'Show PIN'}>
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      )}
      {err && <p className="text-sm text-red-600">{err}</p>}
      <Button type="submit" size="lg" className="w-full" busy={busy} disabled={profile.hasPin && pin.length < 4}>
        {profile.hasPin ? 'Login' : 'Continue'}
      </Button>
    </form>
  );
}

function CreateProfile({ onDone }: { onDone: (p: ProfilePublic) => void }) {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('Dr.');
  const [department, setDepartment] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      onDone(await call(api.createProfile({ name, title, department, pin: pin || undefined })));
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="text-center text-sm text-slate-600 dark:text-slate-400">Create your local profile. It is stored only on this computer.</p>
      <div className="grid grid-cols-[96px_1fr] gap-2">
        <Select value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title">
          {['Dr.', 'Prof.', 'Mr.', 'Ms.', 'Mrs.', ''].map((t) => (
            <option key={t} value={t}>{t || '(none)'}</option>
          ))}
        </Select>
        <Input autoFocus required placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} leading={<User className="h-4 w-4" />} aria-label="Name" />
      </div>
      <Input placeholder="Department (optional)" value={department} onChange={(e) => setDepartment(e.target.value)} leading={<Building2 className="h-4 w-4" />} aria-label="Department" />
      <Field label="PIN (optional)" hint="4–8 digits. Locks the app when others use this computer.">
        <Input type="password" inputMode="numeric" placeholder="e.g. 4821" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} leading={<KeyRound className="h-4 w-4" />} />
      </Field>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <Button type="submit" size="lg" className="w-full" busy={busy} disabled={!name.trim() || (pin.length > 0 && pin.length < 4)}>
        Get started
      </Button>
    </form>
  );
}
