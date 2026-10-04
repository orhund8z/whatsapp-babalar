import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, History, LoaderCircle, RotateCcw, X, CheckCircle2, Square } from "lucide-react";

type HistoryState = {
  status: "queued" | "running" | "idle" | "error" | "exhausted";
  before_at: string;
  page_size: number;
  pages?: number;
  scanned?: number;
  saved?: number;
  last_scanned?: number;
  last_saved?: number;
  exhausted?: boolean;
  error?: string;
};

export type HistoryGroup = {
  id: string;
  name: string;
  message_count: number;
  oldest_message_at: string | null;
  newest_message_at: string | null;
  history_initial_before_at?: string;
  history?: HistoryState | null;
};

const date = (value?: string | null) => value
  ? new Date(value).toLocaleDateString("tr-TR", { day: "numeric", month: "short", year: "numeric" }) : "—";

export default function GroupHistoryPanel({ group, pending, cancelling, error, onFetch, onCancel, onClose }: {
  group: HistoryGroup;
  pending: boolean;
  cancelling: boolean;
  error: string | null;
  onFetch: (size: number, recheck: boolean) => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pageSize, setPageSize] = useState(group.history?.page_size ?? 500);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  const h = group.history;
  const busy = pending || h?.status === "queued" || h?.status === "running";
  const exhausted = h?.status === "exhausted";
  const failed = h?.status === "error";
  const status = h?.status === "queued" ? "Sırada"
    : h?.status === "running" ? "Geçmiş taranıyor"
    : exhausted ? "Erişilebilir geçmişin sonu"
    : failed ? "Tarama tamamlanamadı"
    : h ? "Sonraki sayfa hazır" : "Geçmiş taraması";
  return (
    <dialog ref={dialog} onClose={onClose} onClick={e => { if (e.target === dialog.current) dialog.current.close(); }}
      aria-labelledby="history-title"
      className="fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-none w-full max-w-md border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white p-0 shadow-xl backdrop:bg-black/40">
      <div className="flex min-h-full flex-col">
        <header className="flex items-start gap-3 border-b border-gray-200 dark:border-gray-800 p-5">
          <History size={20} className="mt-1 shrink-0 text-gray-500" />
          <div className="min-w-0 flex-1">
            <h2 id="history-title" className="text-base font-semibold">Mesaj geçmişi</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 break-words">{group.name}</p>
          </div>
          <button autoFocus aria-label="Geçmiş panelini kapat" title="Kapat" onClick={() => dialog.current?.close()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-gray-100 dark:hover:bg-gray-800"><X size={18} /></button>
        </header>
        <div className="flex-1 p-5 space-y-6">
          <div className="flex items-center gap-2 text-sm font-medium" role="status" aria-live="polite">
            {busy ? <LoaderCircle size={17} className="animate-spin text-blue-600" />
              : exhausted ? <CheckCircle2 size={17} className="text-green-600" /> : <History size={17} className="text-gray-500" />}
            {pending ? "Sıraya alınıyor" : status}
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-5 text-sm">
            <div><dt className="text-xs text-gray-500">Kayıtlı mesaj</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{group.message_count.toLocaleString("tr-TR")}</dd></div>
            <div><dt className="text-xs text-gray-500">Tamamlanan sayfa</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{h?.pages ?? 0}</dd></div>
            <div><dt className="text-xs text-gray-500">İlk kayıtlı mesaj</dt><dd className="mt-1 font-medium">{date(group.oldest_message_at)}</dd></div>
            <div><dt className="text-xs text-gray-500">Son kayıtlı mesaj</dt><dd className="mt-1 font-medium">{date(group.newest_message_at)}</dd></div>
          </dl>
          <div className="border-y border-gray-200 dark:border-gray-800 py-4">
            <p className="text-xs text-gray-500">Sonraki sayfa sınırı</p>
            <p className="mt-1 text-sm font-medium">{date(h?.before_at ?? group.oldest_message_at ?? group.history_initial_before_at)} öncesi</p>
            {h?.before_at && <p className="mt-1 text-xs text-gray-500 tabular-nums">{new Date(h.before_at).toLocaleTimeString("tr-TR")}</p>}
          </div>
          {h && h.last_scanned !== undefined && <div>
            <p className="text-xs font-medium text-gray-500">Son sayfa</p>
            <p className="mt-2 text-sm tabular-nums">{h.last_scanned.toLocaleString("tr-TR")} tarandı · {(h.last_saved ?? 0).toLocaleString("tr-TR")} yeni kayıt</p>
            <p className="mt-1 text-xs text-gray-500">Toplam {(h.scanned ?? 0).toLocaleString("tr-TR")} tarandı · {(h.saved ?? 0).toLocaleString("tr-TR")} yeni kayıt</p>
          </div>}
          {exhausted && <p className="text-sm text-gray-500">WhatsApp bu grupta daha eski mesaj sunmadı.</p>}
          {(error || failed) && <div role="alert" className="border-l-2 border-red-500 pl-3 text-sm text-red-600 dark:text-red-400">
            {error || "Sayfa tamamlanamadı. Tarama sınırı korunuyor."}
            {failed && h?.error && <details className="mt-2 text-xs"><summary className="cursor-pointer">Hata ayrıntısı</summary><p className="mt-2 whitespace-pre-wrap break-words">{h.error}</p></details>}
          </div>}
        </div>
        <footer className="sticky bottom-0 border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 space-y-3">
          <label className="flex items-center justify-between gap-3 text-sm">
            Sayfa boyutu
            <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))} disabled={busy}
              className="rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm disabled:opacity-50">
              {[250, 500, 1000].map(size => <option key={size} value={size}>{size.toLocaleString("tr-TR")} mesaj</option>)}
            </select>
          </label>
          <button disabled={busy} onClick={() => onFetch(pageSize, exhausted)}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {busy ? <LoaderCircle size={17} className="animate-spin" /> : (failed || exhausted) ? <RotateCcw size={17} /> : <ArrowDownToLine size={17} />}
            {busy ? (h?.status === "running" ? "Sayfa işleniyor" : "Sırada") : failed ? "Aynı sayfayı tekrar dene" : exhausted ? "Tekrar kontrol et" : "Daha eski mesajları çek"}
          </button>
          {(h?.status === "queued" || h?.status === "running") && <button disabled={cancelling} onClick={onCancel}
            className="flex min-h-10 w-full items-center justify-center gap-2 rounded-md text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">
            <Square size={14} />{cancelling ? "Durduruluyor" : h.status === "queued" ? "Sıradan çıkar" : "Taramayı durdur"}
          </button>}
        </footer>
      </div>
    </dialog>
  );
}
