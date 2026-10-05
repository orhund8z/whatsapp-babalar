import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileUp, LoaderCircle, X } from "lucide-react";
import api from "../api/client";

type ImportReport = {
  dry_run: boolean;
  parsed: number;
  skipped_system: number;
  skipped_media: number;
  eligible: number;
  new: number;
  first_at: string | null;
  last_at: string | null;
  saved?: number;
  sample: { sent_at: string; sender: string; content: string }[];
};

const fmt = (v?: string | null) => v ? new Date(v).toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" }) : "—";
const num = (n: number) => n.toLocaleString("tr-TR");

export default function ChatImportPanel({ group, onClose }: { group: { id: string; name: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  async function run(dryRun: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append("file", file);
    form.append("dry_run", String(dryRun));
    try {
      const res = await api.post(`/admin/groups/${group.id}/import`, form, { timeout: 0 });
      setReport(res.data);
      if (!dryRun) {
        qc.invalidateQueries({ queryKey: ["admin-groups"] });
        qc.invalidateQueries({ queryKey: ["ingestion-logs"] });
      }
    } catch (e: any) {
      setError(e.response?.data?.detail ?? "İçe aktarma başarısız oldu.");
      qc.invalidateQueries({ queryKey: ["ingestion-logs"] });
    } finally {
      setBusy(false);
    }
  }

  const done = report && !report.dry_run;
  return (
    <dialog ref={dialog} onClose={onClose} onClick={e => { if (e.target === dialog.current) dialog.current.close(); }}
      aria-labelledby="import-title"
      className="fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-none w-full max-w-md border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white p-0 shadow-xl backdrop:bg-black/40">
      <div className="flex min-h-full flex-col">
        <header className="flex items-start gap-3 border-b border-gray-200 dark:border-gray-800 p-5">
          <FileUp size={20} className="mt-1 shrink-0 text-gray-500" />
          <div className="min-w-0 flex-1">
            <h2 id="import-title" className="text-base font-semibold">Sohbet dosyası yükle</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 break-words">{group.name}</p>
          </div>
          <button autoFocus aria-label="Paneli kapat" title="Kapat" onClick={() => dialog.current?.close()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-gray-100 dark:hover:bg-gray-800"><X size={18} /></button>
        </header>
        <div className="flex-1 space-y-5 p-5 text-sm">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            WhatsApp → grup → Sohbeti dışa aktar → Medyasız (.txt veya .zip). Saatler Europe/Berlin kabul edilir; zaten kayıtlı mesajlar atlanır. Hatalar Loglar sekmesine de yazılır.
          </p>
          <input type="file" accept=".txt,.zip" disabled={busy} onChange={e => { setFile(e.target.files?.[0] ?? null); setReport(null); setError(null); }} className="block w-full text-sm" />
          <div className="flex items-center gap-2">
            <button disabled={!file || busy} onClick={() => run(true)}
              className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 disabled:opacity-40">Önizle</button>
            <button disabled={!report?.dry_run || report.new === 0 || busy} onClick={() => run(false)}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-white disabled:opacity-40">
              {report?.dry_run && report.new > 0 ? `${num(report.new)} mesajı içe aktar` : "İçe aktar"}
            </button>
            {busy && <LoaderCircle size={16} className="animate-spin text-blue-600" />}
          </div>
          {error && <p role="alert" className="rounded-lg bg-red-50 dark:bg-red-900/30 p-3 text-red-600 dark:text-red-400">{error}</p>}
          {report && (
            <div role="status" className="space-y-2">
              <p className="font-medium">{done ? `Tamamlandı: ${num(report.saved ?? 0)} mesaj kaydedildi` : "Önizleme"}</p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                <div><dt className="text-xs text-gray-500">Okunan mesaj</dt><dd className="font-semibold tabular-nums">{num(report.parsed)}</dd></div>
                <div><dt className="text-xs text-gray-500">Yeni</dt><dd className="font-semibold tabular-nums">{num(report.new)}</dd></div>
                <div><dt className="text-xs text-gray-500">Uygun (≥40 karakter)</dt><dd className="tabular-nums">{num(report.eligible)}</dd></div>
                <div><dt className="text-xs text-gray-500">Atlanan (medya / sistem)</dt><dd className="tabular-nums">{report.skipped_media} / {report.skipped_system}</dd></div>
                <div className="col-span-2"><dt className="text-xs text-gray-500">Tarih aralığı</dt><dd>{fmt(report.first_at)} – {fmt(report.last_at)}</dd></div>
              </dl>
              {report.dry_run && report.sample.map((s, i) => (
                <p key={i} className="truncate text-xs text-gray-500 dark:text-gray-400">[{fmt(s.sent_at)}] {s.sender}: {s.content}</p>
              ))}
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}
