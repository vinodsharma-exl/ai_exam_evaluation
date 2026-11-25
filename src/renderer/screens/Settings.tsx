/**
 * Settings: AI models per stage, provider keys (encrypted) with Test connection and editable capability
 * flags, grading, image quality, data folder (open/change/backup/restore), appearance, profile/PIN, privacy.
 */
import { useEffect, useState } from 'react';
import { Archive, CheckCircle2, ExternalLink, FolderOpen, FolderSync, KeyRound, Plug, RefreshCw, RotateCcw, Trash2, XCircle, Eye, ScanText, Calculator } from 'lucide-react';
import type { ProviderId, Stage } from '../../shared/schemas/common';
import type { ModelCapabilities } from '../../shared/schemas/config';
import type { ProviderStatus } from '../../shared/ipc';
import { IMAGE_QUALITY_PRESETS } from '../../shared/constants';
import { api, call } from '../lib/api';
import { useAction, useAsync } from '../lib/hooks';
import { useApp } from '../lib/app-context';
import type { SettingsTab } from '../lib/router';
import { fmtDateTime } from '../lib/format';
import { Badge, Button, Card, Field, Input, Loading, Modal, PageHeader, Segmented, Select, Textarea, Toggle, cx } from '../components/ui';
import { ErrorBanner } from '../components/ErrorBanner';
import { PrivacyText } from '../components/PrivacyNotice';
import { useTitle } from '../components/Shell';

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'models', label: 'AI models' },
  { id: 'providers', label: 'Providers & keys' },
  { id: 'grading', label: 'Grading' },
  { id: 'images', label: 'Image quality' },
  { id: 'data', label: 'Data folder' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'profile', label: 'Profile & PIN' },
  { id: 'privacy', label: 'Privacy' },
];

export function SettingsScreen({ initialTab }: { initialTab?: SettingsTab }) {
  useTitle('Settings');
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'models');
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-6 lg:grid-cols-[200px_1fr]">
        <nav className="flex flex-row flex-wrap gap-1 lg:flex-col" aria-label="Settings sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              className={cx('rounded-lg px-3 py-2 text-left text-sm', tab === t.id ? 'bg-brand-50 font-semibold text-brand-700 dark:bg-brand-700/30 dark:text-brand-100' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800')}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0">
          {tab === 'models' && <ModelsTab />}
          {tab === 'providers' && <ProvidersTab />}
          {tab === 'grading' && <GradingTab />}
          {tab === 'images' && <ImagesTab />}
          {tab === 'data' && <DataTab />}
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'profile' && <ProfileTab />}
          {tab === 'privacy' && (
            <Card title="Privacy notice">
              <PrivacyText />
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------------------------------ models
function ModelsTab() {
  const providers = useAsync(() => call(api.getProviders()), []);
  const { config } = useApp();
  if (!providers.data || !config) return <Loading />;
  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-brand-100 bg-brand-50 p-4 text-sm dark:border-brand-700 dark:bg-brand-700/20">
        <p className="font-semibold">Two stages, so free models go further</p>
        <p className="mt-1 text-slate-700 dark:text-slate-300">
          <strong>Reading</strong> handwriting needs a model that can see images (vision). <strong>Grading</strong> only needs text, so any free text model works. With Google Gemini, using <em>Flash</em> for reading and <em>Flash-Lite</em> for grading uses two separate daily quotas from one free key.
        </p>
      </div>
      <StageCard stage="ocr" providers={providers.data} />
      <StageCard stage="evaluation" providers={providers.data} />
    </div>
  );
}

function StageCard({ stage, providers }: { stage: Stage; providers: ProviderStatus[] }) {
  const { config, toast } = useApp();
  const ref = config!.stages[stage];
  const [providerId, setProviderId] = useState<ProviderId>(ref.providerId);
  const [model, setModel] = useState(ref.model);
  const [custom, setCustom] = useState('');
  const [listed, setListed] = useState<string[] | null>(null);
  const act = useAction();
  const p = providers.find((x) => x.info.id === providerId)!;
  const presetIds = p.models.map((m) => m.id);
  const options = [...new Set([...presetIds, ...(listed ?? [])])];
  const caps = p.models.find((m) => m.id === model)?.capabilities;
  const needsVision = stage === 'ocr';
  const changed = providerId !== ref.providerId || model !== ref.model;

  const save = async (m = model) => {
    const r = await act.run(() => call(api.setStageModel(stage, { providerId, model: m })));
    if (r) toast(`${stage === 'ocr' ? 'Reading' : 'Grading'} model saved`);
  };

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {stage === 'ocr' ? <ScanText className="h-4 w-4 text-brand-600" /> : <Calculator className="h-4 w-4 text-brand-600" />}
          {stage === 'ocr' ? 'Stage A: Reading handwriting (vision)' : 'Stage B: Grading (text only)'}
        </span>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Provider">
          <Select
            value={providerId}
            onChange={(e) => {
              const id = e.target.value as ProviderId;
              setProviderId(id);
              const prov = providers.find((x) => x.info.id === id)!;
              const pick = prov.info.presets.find((pr) => pr.tags.includes(stage === 'ocr' ? 'recommended-ocr' : 'recommended-eval')) ?? prov.info.presets.find((pr) => !needsVision || pr.capabilities.supportsVision) ?? prov.info.presets[0];
              setModel(pick?.id ?? '');
              setListed(null);
            }}
          >
            {providers.map((x) => (
              <option key={x.info.id} value={x.info.id}>
                {x.info.displayName}
                {x.hasKey ? '' : '  (no key yet)'}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Model" hint={p.info.allowsCustomModel ? 'Free model names change often. Refresh the list or type a model id.' : undefined}>
          <div className="flex gap-2">
            <Select value={options.includes(model) ? model : '__custom'} onChange={(e) => e.target.value !== '__custom' && setModel(e.target.value)}>
              {options.map((id) => {
                const preset = p.info.presets.find((pr) => pr.id === id);
                return (
                  <option key={id} value={id}>
                    {preset?.label ?? id}
                    {preset?.tags.includes('free') ? ' · free' : ''}
                    {preset ? (preset.capabilities.supportsVision ? ' · vision' : ' · text') : ''}
                  </option>
                );
              })}
              {!options.includes(model) && <option value="__custom">{model}</option>}
            </Select>
            {p.info.allowsCustomModel && p.hasKey && (
              <Button variant="secondary" title="Fetch the models your key can use" busy={act.busy} onClick={async () => {
                const list = await act.run(() => call(api.listModels(providerId)));
                if (list) setListed(list);
              }} icon={<RefreshCw className="h-4 w-4" />} />
            )}
          </div>
        </Field>
        {p.info.allowsCustomModel && (
          <div className="md:col-span-2 flex items-end gap-2">
            <Field label="Or type a model id">
              <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="e.g. meta-llama/llama-3.3-70b-instruct:free" />
            </Field>
            <Button variant="secondary" disabled={!custom.trim()} onClick={() => { setModel(custom.trim()); setCustom(''); }}>Use</Button>
          </div>
        )}
      </div>

      {caps && (
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <Badge tone={caps.supportsVision ? 'green' : 'gray'}>{caps.supportsVision ? `Vision · up to ${caps.maxImagesPerRequest} pages/request` : 'Text only'}</Badge>
          <Badge>{caps.requestsPerMinute}/min</Badge>
          <Badge>{caps.dailyLimit === null ? 'no daily cap' : `${caps.dailyLimit}/day`}</Badge>
          <Badge>{Math.round(caps.contextWindow / 1000)}k context</Badge>
        </div>
      )}
      {needsVision && caps && !caps.supportsVision && (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          This model can't read images. Choose a vision model for reading, or you'll type the page text yourself.
        </p>
      )}
      {!p.hasKey && <p className="mt-3 text-sm text-amber-700">No API key for {p.info.displayName} yet. Add it under Providers & keys.</p>}
      <div className="mt-4 flex justify-end">
        <Button disabled={!changed || !model} busy={act.busy} onClick={() => void save()}>Save</Button>
      </div>
      <ErrorBanner error={act.error} onDismiss={() => act.setError(null)} />
    </Card>
  );
}

// ------------------------------------------------------------------------------------------ providers
function ProvidersTab() {
  const providers = useAsync(() => call(api.getProviders()), []);
  const { config } = useApp();
  if (!providers.data || !config) return <Loading />;
  const inUse = new Set([`${config.stages.ocr.providerId}`, `${config.stages.evaluation.providerId}`]);
  const sorted = [...providers.data].sort((a, b) => Number(inUse.has(b.info.id)) - Number(inUse.has(a.info.id)));
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Keys are encrypted with your Windows account and stored only on this computer. They are never shown again and never logged.
      </p>
      {sorted.map((p) => (
        <ProviderCard key={p.info.id} p={p} inUse={inUse.has(p.info.id)} onChanged={providers.reload} />
      ))}
    </div>
  );
}

function ProviderCard({ p, inUse, onChanged }: { p: ProviderStatus; inUse: boolean; onChanged: () => Promise<void> }) {
  const { config, toast, updateConfig } = useApp();
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(config?.providers[p.info.id]?.baseUrl ?? '');
  const [edit, setEdit] = useState<string | null>(null);
  const [test, setTest] = useState<Record<string, { text: boolean; vision: boolean | null; message: string } | 'busy'>>({});
  const act = useAction();
  const stageModels = [config!.stages.ocr, config!.stages.evaluation].filter((r) => r.providerId === p.info.id).map((r) => r.model);
  const shown = p.models.filter((m) => stageModels.includes(m.id) || m.userEdited || m.lastTest);

  const saveKey = async () => {
    const r = await act.run(() => call(api.saveApiKey(p.info.id, key)));
    if (r) {
      setKey('');
      toast(`${p.info.displayName} key saved (encrypted)`);
      await onChanged();
    }
  };

  const runTest = async (model: string) => {
    setTest((t) => ({ ...t, [model]: 'busy' }));
    const r = await act.run(() => call(api.testConnection({ providerId: p.info.id, model })));
    setTest((t) => {
      const n = { ...t };
      if (r) n[model] = r;
      else delete n[model];
      return n;
    });
    await onChanged();
  };

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {p.info.displayName}
          {inUse && <Badge tone="blue">in use</Badge>}
          {p.info.hasFreeTier && p.info.id !== 'mock' && <Badge tone="green">free tier</Badge>}
          {p.info.id !== 'mock' && (p.hasKey ? <Badge tone="green"><KeyRound className="h-3 w-3" /> key saved</Badge> : <Badge>no key</Badge>)}
        </span>
      }
      actions={p.info.keyUrl && <Button size="sm" variant="ghost" icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => void call(api.openProviderKeyPage(p.info.id))}>Get a key</Button>}
    >
      <div className="space-y-4">
        {p.info.id === 'mock' ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">{p.info.keyHint} Choose it under AI models to try the whole app offline.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-[1fr_auto_auto] md:items-end">
            <Field label="API key" hint={p.info.keyHint}>
              <Input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder={p.hasKey ? '•••••••• (saved; paste to replace)' : 'Paste your key'} />
            </Field>
            <Button busy={act.busy} disabled={!key.trim()} onClick={() => void saveKey()}>Save key</Button>
            {p.hasKey && (
              <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => void act.run(() => call(api.deleteApiKey(p.info.id))).then(onChanged)}>
                Remove
              </Button>
            )}
          </div>
        )}
        {(p.info.id === 'custom' || p.info.id === 'openrouter') && (
          <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <Field label="Base URL" hint={p.info.id === 'custom' ? 'OpenAI-compatible endpoint, e.g. http://localhost:1234/v1' : 'Leave empty for the default.'}>
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={p.info.defaultBaseUrl ?? 'https://…/v1'} />
            </Field>
            <Button variant="secondary" onClick={() => void updateConfig({ providers: { [p.info.id]: { baseUrl: baseUrl.trim() || undefined } } }).then(() => toast('Base URL saved'))}>Save URL</Button>
          </div>
        )}

        {(p.hasKey || p.info.id === 'mock' || p.info.id === 'custom') && (
          <div>
            <p className="mb-2 text-sm font-medium">Models and limits</p>
            <table className="table-base">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Vision</th>
                  <th>Per min</th>
                  <th>Per day</th>
                  <th>Last test</th>
                  <th className="text-right" />
                </tr>
              </thead>
              <tbody>
                {(shown.length ? shown : p.models.slice(0, 3)).map((m) => {
                  const t = test[m.id];
                  const last = m.lastTest;
                  return (
                    <tr key={m.id}>
                      <td>
                        <span className="inline-flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs">{m.id}</span>
                          {stageModels.includes(m.id) && <Badge tone="blue">in use</Badge>}
                        </span>
                      </td>
                      <td>{m.capabilities.supportsVision ? <Eye className="h-4 w-4 text-green-600" aria-label="Vision" /> : <span className="text-slate-400">text</span>}</td>
                      <td>{m.capabilities.requestsPerMinute}</td>
                      <td>{m.capabilities.dailyLimit ?? '∞'}</td>
                      <td className="text-xs">
                        {t === 'busy' ? 'Testing…' : t ? <TestResult r={t} /> : last ? <span title={last.message}>{last.ok ? <CheckCircle2 className="inline h-4 w-4 text-green-600" /> : <XCircle className="inline h-4 w-4 text-red-600" />} {fmtDateTime(last.at)}</span> : <span className="text-slate-400">never</span>}
                      </td>
                      <td>
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="outline" icon={<Plug className="h-3.5 w-3.5" />} disabled={t === 'busy'} onClick={() => void runTest(m.id)}>Test</Button>
                          <Button size="sm" variant="ghost" onClick={() => setEdit(m.id)}>Limits</Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-slate-500">Test connection sends 2 tiny requests (text, then a small image) and records whether the model can read images.</p>
          </div>
        )}
        <ErrorBanner error={act.error} onDismiss={() => act.setError(null)} />
      </div>
      {edit && (
        <CapabilitiesModal
          providerId={p.info.id}
          model={edit}
          caps={p.models.find((m) => m.id === edit)!.capabilities}
          onClose={() => setEdit(null)}
          onSaved={async () => {
            setEdit(null);
            toast('Limits saved');
            await onChanged();
          }}
        />
      )}
    </Card>
  );
}

function TestResult({ r }: { r: { text: boolean; vision: boolean | null; message: string } }) {
  return (
    <span className="flex flex-col">
      <span className={r.text ? 'text-green-700' : 'text-red-600'}>{r.text ? '✓ Connected' : '✗ Failed'}{r.vision !== null && (r.vision ? ' · vision ✓' : ' · text only')}</span>
      <span className="text-slate-500">{r.message}</span>
    </span>
  );
}

function CapabilitiesModal({ providerId, model, caps, onClose, onSaved }: { providerId: ProviderId; model: string; caps: ModelCapabilities; onClose: () => void; onSaved: () => void }) {
  const [c, setC] = useState(caps);
  const act = useAction();
  const num = (k: keyof ModelCapabilities, v: string) => setC({ ...c, [k]: v === '' ? null : Number(v) });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Limits for ${model}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button busy={act.busy} onClick={async () => (await act.run(() => call(api.updateModelCapabilities({ providerId, model }, c)))) && onSaved()}>Save</Button>
        </>
      }
    >
      <p className="mb-4 text-sm text-slate-500">Copy these from your provider's rate-limit page. Lower values are safer: the app paces itself to them.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Requests per minute">
          <Input type="number" min={0.1} step={0.5} value={c.requestsPerMinute} onChange={(e) => num('requestsPerMinute', e.target.value)} />
        </Field>
        <Field label="Requests per day" hint="Empty = no daily cap">
          <Input type="number" min={1} value={c.dailyLimit ?? ''} onChange={(e) => num('dailyLimit', e.target.value)} />
        </Field>
        <Field label="Context window (tokens)">
          <Input type="number" min={1024} value={c.contextWindow} onChange={(e) => num('contextWindow', e.target.value)} />
        </Field>
        <Field label="Max output tokens">
          <Input type="number" min={256} value={c.maxOutputTokens} onChange={(e) => num('maxOutputTokens', e.target.value)} />
        </Field>
        <Field label="Max images per request">
          <Input type="number" min={0} max={20} value={c.maxImagesPerRequest} onChange={(e) => num('maxImagesPerRequest', e.target.value)} />
        </Field>
        <div className="space-y-3 pt-6">
          <Toggle checked={c.supportsVision} onChange={(v) => setC({ ...c, supportsVision: v, maxImagesPerRequest: v ? Math.max(1, c.maxImagesPerRequest) : 0 })} label="Can read images (vision)" />
          <Toggle checked={c.supportsJsonMode} onChange={(v) => setC({ ...c, supportsJsonMode: v })} label="Supports JSON mode" />
        </div>
      </div>
      <div className="mt-3"><ErrorBanner error={act.error} /></div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------ grading
function GradingTab() {
  const { config, updateConfig, toast } = useApp();
  const [g, setG] = useState(config!.grading);
  const act = useAction();
  const dirty = JSON.stringify(g) !== JSON.stringify(config!.grading);
  return (
    <Card title="Grading">
      <div className="space-y-6">
        <Field label="Strictness" hint="Can be overridden per exam.">
          <div>
            <Segmented value={g.strictness} onChange={(v) => setG({ ...g, strictness: v })} options={[{ value: 'lenient', label: 'Lenient' }, { value: 'standard', label: 'Standard' }, { value: 'strict', label: 'Strict' }]} />
            <p className="mt-2 text-xs text-slate-500">
              {g.strictness === 'lenient' && 'Credit correct ideas in any wording; generous partial credit; ignore minor slips and missing units.'}
              {g.strictness === 'standard' && 'Credit a point when its meaning is clearly present; partial credit for partly correct points.'}
              {g.strictness === 'strict' && 'Credit only correct and complete points; penalise wrong units, missing steps and errors.'}
            </p>
          </div>
        </Field>
        <Toggle checked={g.allowHalfMarks} onChange={(v) => setG({ ...g, allowHalfMarks: v })} label="Allow half marks" hint="e.g. 3.5 out of 5. When off, every mark is a whole number." />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Handwriting hint" hint='Helps the reader, e.g. "Cursive; 1 and 7 look similar".'>
            <Textarea rows={2} maxLength={300} value={g.handwritingHint} onChange={(e) => setG({ ...g, handwritingHint: e.target.value })} />
          </Field>
          <Field label="Language hint" hint='e.g. "English with some Hindi terms".'>
            <Textarea rows={2} maxLength={200} value={g.languageHint} onChange={(e) => setG({ ...g, languageHint: e.target.value })} />
          </Field>
          <Field label="Needs-review threshold" hint="Below this AI confidence, a question is marked Needs Review.">
            <Select value={String(g.lowConfidenceThreshold)} onChange={(e) => setG({ ...g, lowConfidenceThreshold: Number(e.target.value) })}>
              {[0.5, 0.6, 0.7, 0.8].map((v) => <option key={v} value={v}>{Math.round(v * 100)}%</option>)}
            </Select>
          </Field>
          <Field label="Questions per grading request" hint="More per request = fewer requests. Falls back to one at a time automatically.">
            <Select value={g.batchQuestions ? String(g.maxQuestionsPerBatch) : '1'} onChange={(e) => setG({ ...g, batchQuestions: e.target.value !== '1', maxQuestionsPerBatch: Math.max(1, Number(e.target.value)) })}>
              {[1, 3, 5, 8, 12].map((v) => <option key={v} value={v}>{v === 1 ? 'One at a time' : `Up to ${v}`}</option>)}
            </Select>
          </Field>
        </div>
        <p className="text-xs text-slate-500">Changing strictness or half marks affects new grading only. To re-grade a student, use "Re-evaluate" on their questions.</p>
        <div className="flex justify-end">
          <Button disabled={!dirty} busy={act.busy} onClick={async () => (await act.run(() => updateConfig({ grading: g }))) && toast('Grading settings saved')}>Save</Button>
        </div>
        <ErrorBanner error={act.error} />
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------ images
function ImagesTab() {
  const { config, updateConfig, toast } = useApp();
  const q = config!.imageQuality;
  const describe = (k: keyof typeof IMAGE_QUALITY_PRESETS) => {
    const p = IMAGE_QUALITY_PRESETS[k];
    return `${p.dpi} DPI · long edge ${p.maxLongEdge}px · grayscale JPEG · up to ${p.pagesPerOcrRequest} pages per request`;
  };
  return (
    <Card title="Page image quality">
      <div className="space-y-3">
        {(Object.keys(IMAGE_QUALITY_PRESETS) as Array<keyof typeof IMAGE_QUALITY_PRESETS>).map((k) => (
          <label key={k} className={cx('flex cursor-pointer items-start gap-3 rounded-lg border p-4', q === k ? 'border-brand-500 bg-brand-50 dark:bg-brand-700/20' : 'border-slate-200 dark:border-slate-700')}>
            <input type="radio" name="quality" checked={q === k} onChange={() => void updateConfig({ imageQuality: k }).then(() => toast('Image quality saved'))} className="mt-1" />
            <span>
              <span className="block font-medium capitalize">
                {k}
                {k === 'medium' && <Badge tone="blue">recommended</Badge>}
              </span>
              <span className="block text-sm text-slate-500">{describe(k)}</span>
              <span className="block text-xs text-slate-500">
                {k === 'low' && 'Fewest requests and smallest uploads. Fine for neat, dark handwriting.'}
                {k === 'medium' && 'Good balance for most scans and phone photos.'}
                {k === 'high' && 'For faint pencil, small writing or dense numerical work. Uses more requests.'}
              </span>
            </span>
          </label>
        ))}
        <p className="text-xs text-slate-500">Applies to pages uploaded from now on. Rotating a page re-renders it at the current quality.</p>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------ data
function DataTab() {
  const { toast, refreshConfig } = useApp();
  const dir = useAsync(() => call(api.getDataDir()), []);
  const act = useAction();
  const [move, setMove] = useState<null | boolean>(null);
  const [restore, setRestore] = useState(false);
  return (
    <div className="space-y-6">
      <Card title="Data folder">
        <p className="break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs dark:bg-slate-800">{dir.data ?? '…'}</p>
        <p className="mt-2 text-sm text-slate-500">Everything lives here as ordinary files (JSON, page images, PDFs). There is no database.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" icon={<FolderOpen className="h-4 w-4" />} onClick={() => void act.run(() => call(api.openDataDir()))}>Open folder</Button>
          <Button variant="secondary" icon={<FolderSync className="h-4 w-4" />} onClick={() => setMove(true)}>Change folder…</Button>
        </div>
      </Card>
      <Card title="Backup and restore">
        <p className="text-sm text-slate-600 dark:text-slate-400">A ZIP of all exams, students, marks and reports. API keys are <strong>not</strong> included; re-enter them after restoring on another computer.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button icon={<Archive className="h-4 w-4" />} busy={act.busy} onClick={async () => {
            const p = await act.run(() => call(api.backupZip()));
            if (p) toast(`Backup saved: ${p}`);
          }}>Create backup (ZIP)</Button>
          <Button variant="secondary" icon={<RotateCcw className="h-4 w-4" />} onClick={() => setRestore(true)}>Restore from backup…</Button>
        </div>
      </Card>
      <ErrorBanner error={act.error} onDismiss={() => act.setError(null)} />

      <Modal
        open={move !== null}
        onClose={() => setMove(null)}
        title="Change data folder"
        footer={
          <>
            <Button variant="secondary" onClick={() => setMove(null)}>Cancel</Button>
            <Button busy={act.busy} onClick={async () => {
              const to = await act.run(() => call(api.changeDataDir({ moveExisting: !!move })));
              setMove(null);
              if (to) {
                toast(`Data folder: ${to}`);
                await dir.reload();
                await refreshConfig();
              }
            }}>Choose folder…</Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <Toggle checked={!!move} onChange={setMove} label="Copy my current data to the new folder" hint="The old folder is kept; delete it yourself once you've checked the new one. Turn this off to switch to a folder that already has AnswerEval data." />
          <p className="text-slate-500">Processing is paused while switching.</p>
        </div>
      </Modal>
      <Modal
        open={restore}
        onClose={() => setRestore(false)}
        title="Restore from backup?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRestore(false)}>Cancel</Button>
            <Button variant="danger" busy={act.busy} onClick={async () => {
              setRestore(false);
              const ok = await act.run(async () => {
                await call(api.restoreZip());
                return true;
              });
              if (ok) {
                toast('Backup restored. Your previous data was kept in a "before-restore" folder.');
                await refreshConfig();
              }
            }}>Choose backup and restore</Button>
          </>
        }
      >
        <p className="text-sm">Your current data folder will be replaced by the backup. Nothing is deleted: the current folder is renamed "…before-restore-…" next to it.</p>
      </Modal>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ appearance
function AppearanceTab() {
  const { config, updateConfig } = useApp();
  return (
    <Card title="Appearance and behaviour">
      <div className="space-y-6">
        <Field label="Theme">
          <div>
            <Segmented value={config!.ui.theme} onChange={(v) => void updateConfig({ ui: { theme: v } })} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'Same as Windows' }]} />
          </div>
        </Field>
        <Toggle checked={config!.ui.confirmBeforeProcessing} onChange={(v) => void updateConfig({ ui: { confirmBeforeProcessing: v } })} label="Show the request estimate before processing" hint="Recommended on free plans." />
        <div className="text-sm">
          <p className="mb-2 font-medium">Keyboard shortcuts</p>
          <ul className="grid gap-1 text-slate-600 dark:text-slate-400 sm:grid-cols-2">
            <li><kbd>Ctrl F</kbd>: search students</li>
            <li><kbd>Ctrl S</kbd>: save</li>
            <li><kbd>Alt →</kbd> / <kbd>Alt ←</kbd>: next / previous question</li>
            <li><kbd>Ctrl Enter</kbd>: save and next</li>
            <li><kbd>Esc</kbd>: close dialog</li>
          </ul>
        </div>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------ profile
/** Shown on report headers and the Excel sheet. */
function InstitutionCard() {
  const { config, updateConfig, toast } = useApp();
  const [f, setF] = useState({ name: config!.institution.name, department: config!.institution.department });
  const act = useAction();
  const logo = config!.institution.logoFile;
  return (
    <Card title="Institution (for reports)">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Institution name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Government College of Science" /></Field>
        <Field label="Department"><Input value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} /></Field>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-sm">Logo: {logo ? <Badge tone="green">set</Badge> : <span className="text-slate-500">none</span>}</span>
        <Button size="sm" variant="secondary" onClick={() => void act.run(() => call(api.chooseInstitutionLogo())).then((c) => c && toast('Logo saved'))}>Choose logo…</Button>
        {logo && <Button size="sm" variant="ghost" onClick={() => void act.run(() => call(api.clearInstitutionLogo()))}>Remove</Button>}
        <Button className="ml-auto" busy={act.busy} onClick={async () => (await act.run(() => updateConfig({ institution: f }))) && toast('Institution saved')}>Save</Button>
      </div>
      <ErrorBanner error={act.error} onDismiss={() => act.setError(null)} />
    </Card>
  );
}

function ProfileTab() {
  const { profile, setProfile, toast } = useApp();
  const [f, setF] = useState({ name: profile!.name, title: profile!.title, department: profile!.department });
  const [pins, setPins] = useState({ current: '', next: '' });
  const act = useAction();
  return (
    <div className="space-y-6">
      <Card title="Profile">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Title"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Department"><Input value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} /></Field>
        </div>
        <div className="mt-4 flex justify-end">
          <Button busy={act.busy} onClick={async () => {
            const p = await act.run(() => call(api.updateProfile(f)));
            if (p) {
              setProfile(p);
              toast('Profile saved');
            }
          }}>Save</Button>
        </div>
      </Card>
      <InstitutionCard />
      <Card title="PIN">
        <div className="grid gap-4 md:grid-cols-2">
          {profile!.hasPin && <Field label="Current PIN"><Input type="password" inputMode="numeric" value={pins.current} onChange={(e) => setPins({ ...pins, current: e.target.value.replace(/\D/g, '') })} /></Field>}
          <Field label={profile!.hasPin ? 'New PIN (empty = remove PIN)' : 'New PIN'} hint="4–8 digits">
            <Input type="password" inputMode="numeric" value={pins.next} onChange={(e) => setPins({ ...pins, next: e.target.value.replace(/\D/g, '').slice(0, 8) })} />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <Button busy={act.busy} disabled={!profile!.hasPin && pins.next.length < 4} onClick={async () => {
            const ok = await act.run(async () => {
              await call(api.changePin(pins.current || undefined, pins.next || undefined));
              return true;
            });
            if (ok) {
              setProfile({ ...profile!, hasPin: !!pins.next });
              setPins({ current: '', next: '' });
              toast(pins.next ? 'PIN updated' : 'PIN removed');
            }
          }}>{profile!.hasPin ? 'Change PIN' : 'Set PIN'}</Button>
        </div>
      </Card>
      <ErrorBanner error={act.error} onDismiss={() => act.setError(null)} />
    </div>
  );
}
