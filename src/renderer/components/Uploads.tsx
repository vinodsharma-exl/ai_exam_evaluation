/**
 * Upload UI from the screenshot: dashed drop area with "Choose File", file rows with a green check,
 * plus a page grid to reorder (drag or arrows), rotate and remove pages before processing.
 */
import { useEffect, useState, type DragEvent } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, FileText, Image as ImageIcon, RotateCw, Trash2, Undo2, Upload, ZoomIn } from 'lucide-react';
import type { UploadedPagePreview } from '../../shared/ipc';
import type { StudentFile } from '../../shared/schemas/student';
import { api, call } from '../lib/api';
import { Button, Modal, Spinner, cx } from './ui';

export function Dropzone({
  title,
  subtitle,
  busy,
  onPaths,
  onPick,
  compact,
}: {
  title: string;
  subtitle?: string;
  busy?: boolean;
  onPaths: (paths: string[]) => void;
  onPick: () => void;
  compact?: boolean;
}) {
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length) onPaths(paths);
  };
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cx(
        'flex flex-col items-center justify-center rounded-xl border-2 border-dashed text-center transition-colors',
        compact ? 'gap-1 px-4 py-5' : 'gap-2 px-6 py-10',
        over ? 'border-brand-500 bg-brand-50 dark:bg-brand-700/20' : 'border-slate-300 bg-slate-50/60 dark:border-slate-700 dark:bg-slate-900/40',
      )}
    >
      {busy ? <Spinner className="h-8 w-8" /> : <Upload className={cx('text-slate-500', compact ? 'h-6 w-6' : 'h-9 w-9')} />}
      <p className="font-semibold text-slate-800 dark:text-slate-100">{busy ? 'Preparing pages…' : title}</p>
      {!busy && (
        <>
          <p className="text-sm text-slate-500">Drag and drop files here, or click to browse</p>
          {subtitle && <p className="text-xs text-slate-400">{subtitle}</p>}
          <Button className="mt-2" onClick={onPick} disabled={busy}>
            Choose File
          </Button>
        </>
      )}
    </div>
  );
}

export function FileRow({ name, meta, onRemove, kind }: { name: string; meta?: string; onRemove?: () => void; kind?: string }) {
  const Icon = kind === 'pdf' || kind === undefined ? FileText : ImageIcon;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5 dark:border-slate-700 dark:bg-slate-900">
      <Icon className="h-5 w-5 shrink-0 text-brand-600" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{name}</p>
        {meta && <p className="text-xs text-slate-500">{meta}</p>}
      </div>
      <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600" aria-label="Ready" />
      {onRemove && (
        <button type="button" onClick={onRemove} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-800" aria-label={`Remove ${name}`}>
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

type Item = { index: number; rotation: 0 | 90 | 180 | 270; deleted: boolean };

/** Page grid with local edits; nothing changes on disk until "Apply changes". */
export function PageGrid({
  examId,
  studentId,
  previews,
  uploads,
  onChanged,
  disabled,
}: {
  examId: string;
  studentId: string;
  previews: UploadedPagePreview[];
  uploads: StudentFile['uploads'];
  onChanged: (p: UploadedPagePreview[]) => void;
  disabled?: boolean;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [drag, setDrag] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);
  const [zoomSrc, setZoomSrc] = useState<string | null>(null);

  useEffect(() => {
    setItems(previews.map((p) => ({ index: p.index, rotation: p.rotation, deleted: false })));
  }, [previews]);
  useEffect(() => {
    if (zoom === null) {
      setZoomSrc(null);
      return;
    }
    void call(api.getPageImage(examId, studentId, zoom)).then(setZoomSrc).catch(() => setZoomSrc(null));
  }, [zoom, examId, studentId]);

  const byIndex = new Map(previews.map((p) => [p.index, p]));
  const dirty = items.some((it, i) => it.deleted || it.index !== previews[i]?.index || it.rotation !== previews[i]?.rotation);
  const move = (from: number, to: number) =>
    setItems((xs) => {
      if (to < 0 || to >= xs.length) return xs;
      const next = [...xs];
      const [m] = next.splice(from, 1);
      next.splice(to, 0, m!);
      return next;
    });
  const update = (i: number, patch: Partial<Item>) => setItems((xs) => xs.map((x, k) => (k === i ? { ...x, ...patch } : x)));

  const apply = async () => {
    setBusy(true);
    try {
      onChanged(await call(api.arrangePages(examId, studentId, items)));
    } finally {
      setBusy(false);
    }
  };

  const removeUpload = (uploadIndex: number) =>
    setItems((xs) => xs.map((x) => (byIndex.get(x.index)?.source.uploadIndex === uploadIndex ? { ...x, deleted: true } : x)));

  if (previews.length === 0) return null;
  const live = items.filter((i) => !i.deleted).length;
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {uploads.map((u, i) => (
          <FileRow key={i} kind={u.kind} name={u.originalName} meta={`${u.pageCount} page${u.pageCount === 1 ? '' : 's'}`} onRemove={disabled ? undefined : () => removeUpload(i)} />
        ))}
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-600 dark:text-slate-400">
          <strong>{live}</strong> page{live === 1 ? '' : 's'} in reading order. Drag to reorder, rotate sideways photos, remove extra pages.
        </p>
        {dirty && (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" icon={<Undo2 className="h-4 w-4" />} onClick={() => setItems(previews.map((p) => ({ index: p.index, rotation: p.rotation, deleted: false })))}>
              Undo
            </Button>
            <Button size="sm" busy={busy} onClick={apply}>
              Apply changes
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
        {items.map((it, i) => {
          const p = byIndex.get(it.index);
          if (!p) return null;
          return (
            <figure
              key={it.index}
              draggable={!disabled}
              onDragStart={() => setDrag(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (drag !== null) move(drag, i);
                setDrag(null);
              }}
              className={cx(
                'group relative rounded-lg border bg-white p-2 shadow-sm dark:bg-slate-900',
                it.deleted ? 'border-red-300 opacity-40' : 'border-slate-200 dark:border-slate-700',
                drag === i && 'ring-2 ring-brand-500',
              )}
            >
              <div className="flex aspect-[3/4] items-center justify-center overflow-hidden rounded bg-slate-100 dark:bg-slate-800">
                {p.thumbDataUrl ? (
                  <img src={p.thumbDataUrl} alt={`Page ${i + 1}`} className="max-h-full max-w-full transition-transform" style={{ transform: `rotate(${(it.rotation - p.rotation + 360) % 360}deg)` }} />
                ) : (
                  <FileText className="h-8 w-8 text-slate-400" />
                )}
              </div>
              <figcaption className="mt-1.5 flex items-center justify-between text-xs">
                <span className="font-medium">Page {i + 1}</span>
                {!disabled && (
                  <span className="flex gap-0.5">
                    <IconBtn label="Move left" onClick={() => move(i, i - 1)}><ArrowLeft className="h-3.5 w-3.5" /></IconBtn>
                    <IconBtn label="Move right" onClick={() => move(i, i + 1)}><ArrowRight className="h-3.5 w-3.5" /></IconBtn>
                    <IconBtn label="Rotate" onClick={() => update(i, { rotation: (((it.rotation + 90) % 360) as Item['rotation']) })}><RotateCw className="h-3.5 w-3.5" /></IconBtn>
                    <IconBtn label={it.deleted ? 'Keep page' : 'Remove page'} onClick={() => update(i, { deleted: !it.deleted })}>
                      {it.deleted ? <Undo2 className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
                    </IconBtn>
                  </span>
                )}
              </figcaption>
              <button type="button" onClick={() => setZoom(it.index)} className="absolute right-3 top-3 hidden rounded bg-white/90 p-1 shadow group-hover:block dark:bg-slate-800" aria-label="Enlarge">
                <ZoomIn className="h-4 w-4" />
              </button>
            </figure>
          );
        })}
      </div>

      <Modal open={zoom !== null} onClose={() => setZoom(null)} title={`Page preview`} wide>
        {zoomSrc ? <img src={zoomSrc} alt="Page" className="mx-auto max-h-[70vh]" /> : <Spinner />}
      </Modal>
    </div>
  );
}

function IconBtn({ children, label, onClick }: { children: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800">
      {children}
    </button>
  );
}
