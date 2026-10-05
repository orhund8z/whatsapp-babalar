import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileUp, LoaderCircle } from "lucide-react";
import api from "../api/client";

type ImportReport = {
  dry_run: boolean;
  timezone: string;
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

export default function ChatImportPanel({ groups }: { groups: { id: string; name: string }[] }) {
  const qc = useQueryClient();
  const [groupId, setGroupId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    if (!file || !groupId) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append("file", file);
    form.append("dry_run", String(dryRun));
    try {
      const res = await api.post(`/admin/groups/${groupId}/import`, form, { timeout: 0 });
      setReport(res.data);
      if (!dryRun) qc.invalidateQueries({ queryKey: ["admin-groups"] });
    } catch (e: any) {
      setError(e.response?.data?.detail ?? "İçe aktarma başarısız oldu.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><FileUp size={16} /> Sohbet dışa aktarımını yükle</h3>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        WhatsApp → grup → Sohbeti dışa aktar → Medyasız. .txt veya .zip. Saatler Europe/Berlin kabul edilir; zaten kayıtlı mesajlar atlanır.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select value={groupId} onChange={e => { setGroupId(e.target.value); setReport(null); }}
          className="rounded-lg border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1.5 text-sm">
          <option value="">Grup seç…</option>
          {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <input type="file" accept=".txt,.zip" onChange={e => { setFile(e.target.files?.[0] ?? null); setReport(null); }} className="text-sm" />
        <button disabled={!file || !groupId || busy} onClick={() => run(true)}
          className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm disabled:opacity-40">Önizle</button>
        <button disabled={!report?.dry_run || report.new === 0 || busy} onClick={() => run(false)}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-40">
          {report?.dry_run && report.new > 0 ? `${report.new.toLocaleString("tr-TR")} mesajı içe aktar` : "İçe aktar"}
        </button>
        {busy && <LoaderCircle size={16} className="animate-spin text-blue-600" />}
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {report && (
        <div role="status" className="text-sm space-y-1">
          <p>
            {report.dry_run ? "Önizleme" : `Tamamlandı: ${report.saved?.toLocaleString("tr-TR")} mesaj kaydedildi`} · {report.parsed.toLocaleString("tr-TR")} mesaj okundu
            ({fmt(report.first_at)} – {fmt(report.last_at)}) · {report.eligible.toLocaleString("tr-TR")} uygun (≥40 karakter) ·{" "}
            <strong>{report.new.toLocaleString("tr-TR")} yeni</strong> · {report.skipped_media} medya, {report.skipped_system} sistem satırı atlandı
          </p>
          {report.dry_run && report.sample.map((s, i) => (
            <p key={i} className="truncate text-xs text-gray-500 dark:text-gray-400">[{fmt(s.sent_at)}] {s.sender}: {s.content}</p>
          ))}
        </div>
      )}
    </section>
  );
}
