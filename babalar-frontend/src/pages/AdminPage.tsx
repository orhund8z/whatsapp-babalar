import { useState, useMemo, useEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import api from "../api/client";
import { useThemeStore } from "../store/theme";
import { useAuthStore } from "../store/auth";

type Tab = "overview" | "groups" | "users" | "config" | "invites" | "logs";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "overview", label: "Genel Bakış", icon: "📊" },
  { id: "groups", label: "Gruplar", icon: "💬" },
  { id: "users", label: "Kullanıcılar", icon: "👥" },
  { id: "config", label: "Konfigürasyon", icon: "⚙️" },
  { id: "invites", label: "Davet Kodları", icon: "🎟️" },
  { id: "logs", label: "Loglar", icon: "📋" },
];

function StatCard({ label, value, sub }: { label: string; value: any; sub?: string }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 border border-gray-100 dark:border-gray-700 shadow-sm">
      <p className="text-2xl font-bold text-green-600">{value ?? "—"}</p>
      <p className="text-sm text-gray-700 dark:text-gray-300 mt-1 font-medium">{label}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function ConfigInput({ value, type = "number", onSave }: { value: string; type?: "number" | "text"; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  const [saved, setSaved] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setV(value); }, [value]);

  function handleChange(next: string) {
    setV(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      onSave(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    }, 600);
  }

  if (type === "text") {
    return (
      <div className="relative mt-2">
        <textarea
          value={v}
          onChange={(e) => handleChange(e.target.value)}
          rows={2}
          className="w-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-500 resize-none"
        />
        {saved && <span className="absolute right-2 bottom-2 text-xs text-green-500">✓ Kaydedildi</span>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        value={v}
        onChange={(e) => handleChange(e.target.value)}
        className="border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded-lg px-3 py-1.5 w-28 text-sm text-right focus:outline-none focus:ring-2 focus:ring-green-500"
      />
      {saved && <span className="text-xs text-green-500">✓</span>}
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  if (role === "owner") return <span className="text-xs bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-400 px-2 py-0.5 rounded-full font-medium">Owner</span>;
  if (role === "admin") return <span className="text-xs bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400 px-2 py-0.5 rounded-full font-medium">Admin</span>;
  return <span className="text-xs text-gray-400">Üye</span>;
}

function UserLimitInput({ value, globalDefault, onSave }: { value: number | null; globalDefault: number; onSave: (v: number | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value ?? ""));

  function commit() {
    setEditing(false);
    const num = parseInt(draft, 10);
    if (draft.trim() === "" || isNaN(num)) {
      onSave(null);
      setDraft("");
    } else {
      onSave(num);
    }
  }

  if (!editing) {
    return (
      <button
        onClick={() => { setDraft(value != null ? String(value) : ""); setEditing(true); }}
        className="text-xs text-left hover:underline"
      >
        {value != null ? (
          <span className="text-blue-600 dark:text-blue-400 font-medium">{value} <span className="text-gray-400 font-normal">(özel)</span></span>
        ) : (
          <span className="text-gray-500">{globalDefault} <span className="text-gray-400">(global)</span></span>
        )}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        autoFocus
        type="number" min={1} value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        placeholder={String(globalDefault)}
        className="border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded px-2 py-0.5 w-20 text-xs focus:outline-none focus:ring-1 focus:ring-green-500"
      />
      <span className="text-xs text-gray-400">boş=global</span>
    </div>
  );
}

function ingestionStatus(g: any): { label: string; cls: string; dot: string } {
  if (!g.is_active) return { label: "Pasif", cls: "bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500", dot: "⚪" };
  if (g.is_ingesting) return { label: "İşleniyor...", cls: "bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 animate-pulse", dot: "🟠" };
  if (g.is_pending) return { label: "Tetiklendi", cls: "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 animate-pulse", dot: "🔵" };
  if (!g.last_ingested_at && (g.message_count ?? 0) === 0) return { label: "Bekliyor", cls: "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400", dot: "🟡" };
  if (!g.last_ingested_at && (g.message_count ?? 0) > 0) return { label: "Yeniden çekilecek", cls: "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400", dot: "🟡" };
  if (g.last_ingested_at && (g.message_count ?? 0) === 0) return { label: "Mesaj yok", cls: "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400", dot: "⚫" };
  return { label: "Çekildi", cls: "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400", dot: "🟢" };
}

export default function AdminPage() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get("tab") as Tab) || "overview";
  const setActiveTab = (tab: Tab) => setSearchParams({ tab }, { replace: true });
  const [newInviteMaxUses, setNewInviteMaxUses] = useState(10);
  const [groupFilter, setGroupFilter] = useState("");
  const [sortKey, setSortKey] = useState<string>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [groupPage, setGroupPage] = useState(0);
  const GROUP_PAGE_SIZE = 25;
  const { theme, toggle } = useThemeStore();
  const currentUser = useAuthStore((s) => s.user);
  const isOwner = currentUser?.role === "owner";

  const { data: config } = useQuery({ queryKey: ["admin-config"], queryFn: () => api.get("/admin/config").then((r) => r.data) });
  const { data: stats } = useQuery({ queryKey: ["admin-stats"], queryFn: () => api.get("/admin/stats").then((r) => r.data) });
  const { data: daily } = useQuery({ queryKey: ["admin-daily"], queryFn: () => api.get("/admin/stats/daily").then((r) => r.data) });
  const { data: topUsers } = useQuery({ queryKey: ["admin-users-stats"], queryFn: () => api.get("/admin/stats/users").then((r) => r.data) });
  const { data: codes } = useQuery({ queryKey: ["invite-codes"], queryFn: () => api.get("/admin/invite-codes").then((r) => r.data) });
  const { data: groups } = useQuery({ queryKey: ["admin-groups"], queryFn: () => api.get("/admin/groups").then((r) => r.data), refetchInterval: activeTab === "groups" ? 10000 : false });
  const { data: users } = useQuery({ queryKey: ["admin-users"], queryFn: () => api.get("/admin/users").then((r) => r.data) });
  const { data: qrData } = useQuery({ queryKey: ["admin-qr"], queryFn: () => api.get("/admin/qr").then((r) => r.data), refetchInterval: activeTab === "groups" ? 5000 : false });
  const { data: waStatus } = useQuery({ queryKey: ["whatsapp-status"], queryFn: () => api.get("/admin/whatsapp/status").then((r) => r.data), refetchInterval: activeTab === "groups" ? 10000 : false });
  const reconnectWA = useMutation({ mutationFn: () => api.post("/admin/whatsapp/reconnect"), onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-qr"] }); qc.invalidateQueries({ queryKey: ["whatsapp-status"] }); } });
  const { data: logs, dataUpdatedAt: logsUpdatedAt } = useQuery({ queryKey: ["ingestion-logs"], queryFn: () => api.get("/admin/logs").then((r) => r.data as { ts: string; level: string; msg: string }[]), refetchInterval: activeTab === "logs" ? 3000 : false });
  const [logFilter, setLogFilter] = useState("");
  const [logLevel, setLogLevel] = useState<"ALL" | "INFO" | "WARN" | "ERROR">("ALL");
  const resetStatus = useMutation({ mutationFn: () => api.post("/admin/ingestion/reset-status"), onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-groups"] }) });

  const filterPreset = config?.group_filter_preset || "";
  const presetTerms = useMemo(
    () => filterPreset.split(",").map((t: string) => t.trim().toLowerCase()).filter(Boolean),
    [filterPreset]
  );

  const filteredGroups = useMemo(() => {
    if (!groups) return [];
    const q = groupFilter.toLowerCase();
    const filtered = groups.filter((g: any) => {
      const name = g.name.toLowerCase();
      const matchesSearch = !q || name.includes(q);
      const matchesPreset = presetTerms.length === 0 || presetTerms.some((t: string) => name.includes(t));
      return matchesSearch && matchesPreset;
    });
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a: any, b: any) => {
      if (sortKey === "message_count") {
        return dir * ((a.message_count ?? 0) - (b.message_count ?? 0));
      }
      if (sortKey === "oldest_message_at" || sortKey === "newest_message_at" || sortKey === "last_ingested_at") {
        const av = a[sortKey] ?? "";
        const bv = b[sortKey] ?? "";
        return dir * av.localeCompare(bv);
      }
      const av = sortKey === "status" ? ingestionStatus(a).label : (a[sortKey] ?? "");
      const bv = sortKey === "status" ? ingestionStatus(b).label : (b[sortKey] ?? "");
      return dir * av.localeCompare(bv, "tr", { sensitivity: "base" });
    });
  }, [groups, groupFilter, presetTerms, sortKey, sortDir]);

  const totalPages = Math.ceil(filteredGroups.length / GROUP_PAGE_SIZE);
  const pagedGroups = filteredGroups.slice(groupPage * GROUP_PAGE_SIZE, (groupPage + 1) * GROUP_PAGE_SIZE);

  const updateConfig = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) => api.put(`/admin/config/${key}`, { value }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-config"] }),
  });
  const createInvite = useMutation({
    mutationFn: () => api.post("/admin/invite-codes", { max_uses: newInviteMaxUses }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invite-codes"] }),
  });
  const deleteInvite = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/invite-codes/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invite-codes"] }),
  });
  const toggleGroup = useMutation({
    mutationFn: (id: string) => api.put(`/admin/groups/${id}/toggle`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-groups"] }),
  });
  const fetchGroup = useMutation({
    mutationFn: (id: string) => api.post(`/admin/groups/${id}/fetch`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-groups"] }),
  });
  const fetchAll = useMutation({
    mutationFn: () => api.post("/admin/groups/fetch-all"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-groups"] }),
  });
  const deleteGroupMessages = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/groups/${id}/messages`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-groups"] }),
    onError: (err: any) => alert("Silme başarısız: " + (err.response?.data?.detail || err.message)),
  });
  const cancelIngestion = useMutation({
    mutationFn: () => api.post("/admin/ingestion/cancel"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-groups"] }),
  });
  const updateUserRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) => api.put(`/admin/users/${id}/role`, { role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-users"] }),
  });
  const updateUserLimit = useMutation({
    mutationFn: ({ id, daily_limit_override }: { id: string; daily_limit_override: number | null }) =>
      api.put(`/admin/users/${id}/limit`, { daily_limit_override }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-users"] }),
  });

  const configKeys = [
    { key: "user_daily_limit", label: "Kişi başı günlük limit", description: "Bir kullanıcının günde sorabileceği maksimum soru sayısı.", type: "number" as const },
    { key: "total_daily_limit", label: "Toplam günlük limit", description: "Tüm kullanıcıların günde toplam sorabileceği maksimum soru sayısı.", type: "number" as const },
    { key: "rag_top_k", label: "RAG sonuç sayısı (top-K)", description: "Her soruda veritabanından çekilecek en benzer mesaj sayısı. Yüksek değer daha zengin bağlam sağlar, düşük değer daha hızlı yanıt verir.", type: "number" as const },
    { key: "ingestion_lookback_days", label: "Geçmişe bakış süresi (gün)", description: "İlk veri çekiminde kaç günlük mesaj geçmişine gidileceği. 3650 = 10 yıl.", type: "number" as const },
    { key: "group_filter_preset", label: "Grup filtre deseni", description: "Sohbet arayüzünde ön tanımlı grup filtresi. Virgülle ayrılmış grup adı parçaları girin — örn: Steuer, Araba, Gurme", type: "text" as const },
  ];

  const chartData = useMemo(() => {
    if (!daily) return [];
    return daily.map((d: any) => ({ ...d, date: d.date.slice(5) }));
  }, [daily]);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col">
      {/* Header */}
      <header className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-4 sm:px-6 py-3 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          <div className="flex items-center gap-2">
            <img src="/logo.jpg" alt="Babalar" className="w-8 h-8 rounded-full object-cover flex-shrink-0" />
            <div>
              <h1 className="font-bold text-gray-900 dark:text-white text-base leading-none">Babalar Admin</h1>
              <p className="text-xs text-gray-400 mt-0.5 hidden sm:block">Yönetim Paneli</p>
            </div>
          </div>
        </div>
        <button onClick={toggle} className="p-2 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar tabs */}
        <nav className="hidden sm:flex flex-col w-52 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 py-4 flex-shrink-0">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-3 px-4 py-2.5 text-sm transition-colors text-left ${
                activeTab === tab.id
                  ? "bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 font-medium border-r-2 border-green-600"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-white"
              }`}
            >
              <span>{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Mobile tab bar */}
        <div className="sm:hidden fixed bottom-0 left-0 right-0 z-10 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 flex">
          {TABS.map((tab) => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`flex-1 py-2 text-xs flex flex-col items-center gap-0.5 transition-colors ${
                activeTab === tab.id ? "text-green-600" : "text-gray-400"
              }`}
            >
              <span className="text-lg leading-none">{tab.icon}</span>
              <span className="hidden xs:block">{tab.label.split(" ")[0]}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 pb-16 sm:pb-6">
          {/* ── Overview ── */}
          {activeTab === "overview" && (
            <div className="space-y-6 max-w-4xl">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Genel Bakış</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                <StatCard label="Toplam Mesaj" value={stats?.total_messages?.toLocaleString()} />
                <StatCard label="Toplam Kullanıcı" value={stats?.total_users} />
                <StatCard label="Bugün Soru" value={stats?.today_questions} />
                <StatCard label="Toplam Soru" value={stats?.total_questions?.toLocaleString()} />
                <StatCard label="Aktif Grup" value={stats?.active_groups} />
              </div>

              <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 border border-gray-100 dark:border-gray-700 shadow-sm">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">Son 30 Gün — Günlük Sorular</h3>
                {chartData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={160}>
                    <BarChart data={chartData} margin={{ top: 0, right: 0, left: -24, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={theme === "dark" ? "#374151" : "#f3f4f6"} />
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: theme === "dark" ? "#9ca3af" : "#6b7280" }} tickLine={false} interval={6} />
                      <YAxis tick={{ fontSize: 10, fill: theme === "dark" ? "#9ca3af" : "#6b7280" }} tickLine={false} axisLine={false} />
                      <Tooltip
                        contentStyle={{ background: theme === "dark" ? "#1f2937" : "#fff", border: "1px solid #374151", borderRadius: 8, fontSize: 12 }}
                        labelStyle={{ color: theme === "dark" ? "#e5e7eb" : "#111" }}
                      />
                      <Bar dataKey="count" name="Soru" fill="#16a34a" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-sm text-gray-400 text-center py-8">Henüz veri yok</p>
                )}
              </div>

              <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 border border-gray-100 dark:border-gray-700 shadow-sm">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">En Aktif Kullanıcılar</h3>
                {topUsers?.length > 0 ? (
                  <div className="space-y-2">
                    {topUsers.map((u: any, i: number) => {
                      const maxTotal = topUsers[0]?.total || 1;
                      return (
                        <div key={u.username} className="flex items-center gap-3">
                          <span className="text-xs text-gray-400 w-4 text-right">{i + 1}</span>
                          <div className="flex-1">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{u.username}</span>
                              <span className="text-xs text-gray-400">{u.total} soru</span>
                            </div>
                            <div className="h-1.5 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                              <div className="h-full bg-green-500 rounded-full" style={{ width: `${(u.total / maxTotal) * 100}%` }} />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 text-center py-4">Henüz soru sorulmadı</p>
                )}
              </div>
            </div>
          )}

          {/* ── Groups ── */}
          {activeTab === "groups" && (
            <div className="space-y-4 max-w-5xl">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">WhatsApp Grupları</h2>
                <div className="flex items-center gap-3">
                  {/* WhatsApp connection status */}
                  {(() => {
                    const status = qrData?.data_url ? "waiting_qr" : (waStatus?.status ?? "unknown");
                    const badge: Record<string, { dot: string; label: string; cls: string }> = {
                      connected:   { dot: "🟢", label: "Bağlı",          cls: "text-green-600 dark:text-green-400" },
                      waiting_qr:  { dot: "🟡", label: "QR Bekleniyor",  cls: "text-yellow-600 dark:text-yellow-400" },
                      disconnected:{ dot: "🔴", label: "Bağlantı Kesik", cls: "text-red-500 dark:text-red-400" },
                      auth_failure:{ dot: "🔴", label: "Auth Hatası",    cls: "text-red-500 dark:text-red-400" },
                      unknown:     { dot: "⚪", label: "Bilinmiyor",     cls: "text-gray-400" },
                    };
                    const b = badge[status] ?? badge.unknown;
                    return <span className={`text-xs font-medium ${b.cls}`}>{b.dot} WhatsApp: {b.label}</span>;
                  })()}
                  <button
                    onClick={() => { if (confirm("WhatsApp oturumu sıfırlanacak ve yeni QR kodu oluşturulacak. Devam?")) reconnectWA.mutate(); }}
                    disabled={reconnectWA.isPending}
                    className="px-3 py-1.5 rounded-xl text-xs font-medium bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 hover:bg-orange-200 dark:hover:bg-orange-900/50 disabled:opacity-50 transition-colors"
                  >
                    ↺ Yeniden Bağlan
                  </button>
                </div>
              </div>

              {qrData?.data_url && (
                <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700 rounded-2xl p-4">
                  <div className="flex flex-col sm:flex-row items-start gap-4">
                    <button
                      type="button"
                      onClick={() => window.open(qrData.data_url, "_blank", "noopener,noreferrer")}
                      className="rounded-xl border border-yellow-200 dark:border-yellow-700 bg-white p-2 shadow-sm hover:shadow-md transition-shadow"
                      title="QR kodu büyük aç"
                    >
                      <img src={qrData.data_url} alt="WhatsApp QR" className="w-56 h-56 sm:w-52 sm:h-52" />
                    </button>
                    <div className="min-w-0">
                      <p className="font-semibold text-yellow-800 dark:text-yellow-300">WhatsApp bağlantısı bekleniyor</p>
                      <p className="text-sm text-yellow-700 dark:text-yellow-400 mt-1.5 leading-relaxed">
                        WhatsApp'ı açın → Bağlı Cihazlar → Cihaz Ekle → QR kodu tarayın
                      </p>
                      <p className="text-xs text-yellow-500 dark:text-yellow-600 mt-2.5 animate-pulse">QR yenilenirse bu panel otomatik güncellenir. Büyütmek için QR'a tıklayın.</p>
                    </div>
                  </div>
                </div>
              )}

              {filterPreset && (
                <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl px-4 py-2.5 text-sm text-green-700 dark:text-green-400">
                  <span className="font-medium">Filtre deseni: </span>{filterPreset}
                  <span className="text-xs ml-2 opacity-70">(Konfigürasyon sekmesinden değiştir)</span>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text" placeholder="Grup adında ara..."
                  value={groupFilter}
                  onChange={(e) => { setGroupFilter(e.target.value); setGroupPage(0); }}
                  className="flex-1 min-w-40 border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 placeholder-gray-400"
                />
                <button
                  onClick={() => fetchAll.mutate()}
                  disabled={fetchAll.isPending}
                  className="px-3 py-2 rounded-xl text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  ↓ Hepsini Çek
                </button>
              </div>

              <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-100 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                      {[
                        { key: "name", label: "Grup", cls: "text-left" },
                        { key: "status", label: "Durum", cls: "text-center" },
                        { key: "message_count", label: "Mesaj", cls: "text-right" },
                        { key: "oldest_message_at", label: "İlk Mesaj", cls: "text-right hidden md:table-cell" },
                        { key: "newest_message_at", label: "Son Mesaj", cls: "text-right hidden md:table-cell" },
                        { key: "last_ingested_at", label: "Son Tarama", cls: "text-right hidden lg:table-cell" },
                      ].map(({ key, label, cls }) => (
                        <th key={key}
                          className={`px-3 py-2.5 whitespace-nowrap cursor-pointer select-none hover:text-gray-700 dark:hover:text-gray-200 transition-colors ${cls}`}
                          onClick={() => { if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortKey(key); setSortDir("asc"); } }}
                        >
                          {label}{sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                        </th>
                      ))}
                      <th className="px-3 py-2.5 text-right w-28"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedGroups.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-400">
                          {groups?.length === 0
                            ? <>Henüz grup keşfedilmedi. <span className="text-blue-500 cursor-pointer" onClick={() => fetchAll.mutate()}>↓ Hepsini Çek</span> butonuna bas.</>
                            : "Sonuç bulunamadı."}
                        </td>
                      </tr>
                    )}
                    {pagedGroups.map((g: any) => {
                      const status = ingestionStatus(g);
                      return (
                        <tr key={g.id} className={`border-b border-gray-50 dark:border-gray-700/50 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors ${!g.is_active ? "opacity-50" : ""}`}>
                          <td className="px-3 py-2.5 max-w-[180px]">
                            <p className="font-medium text-gray-800 dark:text-gray-200 truncate">{g.name}</p>
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${status.cls}`}>
                              {status.dot} {status.label}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right text-gray-600 dark:text-gray-400 tabular-nums whitespace-nowrap">
                            {g.message_count > 0 ? g.message_count.toLocaleString("tr-TR") : "—"}
                          </td>
                          <td className="px-3 py-2.5 text-right text-gray-500 dark:text-gray-400 tabular-nums whitespace-nowrap hidden md:table-cell">
                            {g.oldest_message_at ? new Date(g.oldest_message_at).toLocaleDateString("tr-TR") : "—"}
                          </td>
                          <td className="px-3 py-2.5 text-right text-gray-500 dark:text-gray-400 tabular-nums whitespace-nowrap hidden md:table-cell">
                            {g.newest_message_at ? new Date(g.newest_message_at).toLocaleDateString("tr-TR") : "—"}
                          </td>
                          <td className="px-3 py-2.5 text-right text-gray-500 dark:text-gray-400 tabular-nums whitespace-nowrap hidden lg:table-cell">
                            {g.last_ingested_at ? new Date(g.last_ingested_at).toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" }) : "—"}
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              {g.is_ingesting ? (
                                <button
                                  onClick={() => cancelIngestion.mutate()}
                                  disabled={cancelIngestion.isPending}
                                  title="Çalışan ingestion'ı durdur"
                                  className="px-2 py-1 rounded-full text-xs font-medium bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 hover:bg-orange-100 dark:hover:bg-orange-900/50 disabled:opacity-50 transition-colors"
                                >
                                  ✕ İptal
                                </button>
                              ) : (
                                <button
                                  onClick={() => fetchGroup.mutate(g.id)}
                                  title="Veri çek (son tarihten itibaren)"
                                  className="px-2 py-1 rounded-full text-xs font-medium bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
                                >
                                  ↓ Çek
                                </button>
                              )}
                              <button
                                onClick={() => { if (confirm(`"${g.name}" grubuna ait TÜM mesajlar silinecek. Emin misiniz?`)) deleteGroupMessages.mutate(g.id); }}
                                disabled={g.is_ingesting}
                                title={g.is_ingesting ? "Çekilirken silinemez" : "Tüm mesajları sil"}
                                className="px-2 py-1 rounded-full text-xs font-medium bg-red-50 dark:bg-red-900/30 text-red-500 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                              >
                                🗑
                              </button>
                              <button onClick={() => toggleGroup.mutate(g.id)}
                                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                                  g.is_active ? "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/60"
                                    : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600"
                                }`}
                              >
                                {g.is_active ? "Aktif" : "Pasif"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-between text-sm text-gray-500 dark:text-gray-400">
                  <span>{filteredGroups.length} grup · Sayfa {groupPage + 1}/{totalPages}</span>
                  <div className="flex gap-1">
                    <button
                      onClick={() => setGroupPage(0)}
                      disabled={groupPage === 0}
                      className="px-2 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 transition-colors"
                    >«</button>
                    <button
                      onClick={() => setGroupPage(p => p - 1)}
                      disabled={groupPage === 0}
                      className="px-2 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 transition-colors"
                    >‹</button>
                    {Array.from({ length: totalPages }, (_, i) => i)
                      .filter(i => Math.abs(i - groupPage) <= 2)
                      .map(i => (
                        <button key={i} onClick={() => setGroupPage(i)}
                          className={`px-2.5 py-1 rounded-lg transition-colors ${i === groupPage ? "bg-green-600 text-white" : "hover:bg-gray-100 dark:hover:bg-gray-800"}`}
                        >{i + 1}</button>
                      ))}
                    <button
                      onClick={() => setGroupPage(p => p + 1)}
                      disabled={groupPage >= totalPages - 1}
                      className="px-2 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 transition-colors"
                    >›</button>
                    <button
                      onClick={() => setGroupPage(totalPages - 1)}
                      disabled={groupPage >= totalPages - 1}
                      className="px-2 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 transition-colors"
                    >»</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Users ── */}
          {activeTab === "users" && (
            <div className="space-y-4 max-w-4xl">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Kullanıcılar</h2>
              <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-100 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                      <th className="px-4 py-2.5 text-left">Kullanıcı</th>
                      <th className="px-4 py-2.5 text-left">Rol</th>
                      <th className="px-4 py-2.5 text-left min-w-[180px]">Bugünkü Kullanım</th>
                      <th className="px-4 py-2.5 text-left min-w-[140px]">Günlük Limit</th>
                      <th className="px-4 py-2.5 text-right">Toplam Soru</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users?.map((u: any) => {
                      const isSelf = u.id === currentUser?.id;
                      const isTargetOwner = u.role === "owner";
                      const canChangeRole = !isSelf && (isOwner || (!isTargetOwner && u.role !== "owner"));
                      const usagePct = u.is_admin ? 0 : Math.min(100, (u.today_usage / u.daily_limit) * 100);
                      const barColor = u.is_admin ? "bg-gray-300" : usagePct >= 90 ? "bg-red-500" : usagePct >= 60 ? "bg-yellow-500" : "bg-green-500";

                      return (
                        <tr key={u.id} className="border-b border-gray-50 dark:border-gray-700/50 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="w-7 h-7 rounded-full bg-green-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
                                {u.username?.[0]?.toUpperCase()}
                              </div>
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
                                  {u.username}
                                  {isSelf && <span className="ml-1.5 text-xs text-gray-400">(sen)</span>}
                                </p>
                                <p className="text-xs text-gray-400 truncate">{u.email}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            {canChangeRole ? (
                              <select
                                value={u.role}
                                onChange={(e) => updateUserRole.mutate({ id: u.id, role: e.target.value })}
                                className="text-xs border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-green-500 cursor-pointer"
                              >
                                <option value="member">Üye</option>
                                <option value="admin">Admin</option>
                                {isOwner && <option value="owner">Owner</option>}
                              </select>
                            ) : (
                              <RoleBadge role={u.role} />
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {u.is_admin ? (
                              <span className="text-xs text-gray-400">Limitsiz</span>
                            ) : (
                              <div>
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-xs text-gray-500 dark:text-gray-400">{u.today_usage} / {u.daily_limit}</span>
                                </div>
                                <div className="h-1.5 bg-gray-100 dark:bg-gray-600 rounded-full overflow-hidden w-32">
                                  <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${usagePct}%` }} />
                                </div>
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {u.is_admin ? (
                              <span className="text-xs text-gray-400">—</span>
                            ) : (
                              <UserLimitInput
                                value={u.daily_limit_override}
                                globalDefault={u.daily_limit}
                                onSave={(val) => updateUserLimit.mutate({ id: u.id, daily_limit_override: val })}
                              />
                            )}
                          </td>
                          <td className="px-4 py-3 text-right text-gray-600 dark:text-gray-400 tabular-nums">
                            {(topUsers?.find((t: any) => t.username === u.username)?.total ?? 0)}
                          </td>
                        </tr>
                      );
                    })}
                    {!users?.length && (
                      <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-400">Kullanıcı bulunamadı</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Config ── */}
          {activeTab === "config" && (
            <div className="space-y-4 max-w-xl">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Konfigürasyon</h2>
              <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm divide-y divide-gray-50 dark:divide-gray-700/50">
                {configKeys.map(({ key, label, description, type }) => (
                  <div key={key} className="px-4 py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-gray-800 dark:text-gray-200">{label}</p>
                        <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{description}</p>
                      </div>
                      {type === "number" && (
                        <ConfigInput type="number" value={config?.[key] || ""} onSave={(val) => updateConfig.mutate({ key, value: val })} />
                      )}
                    </div>
                    {type === "text" && (
                      <ConfigInput type="text" value={config?.[key] || ""} onSave={(val) => updateConfig.mutate({ key, value: val })} />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Invites ── */}
          {activeTab === "invites" && (
            <div className="space-y-4 max-w-xl">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Davet Kodları</h2>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min={1} value={newInviteMaxUses}
                    onChange={(e) => setNewInviteMaxUses(Number(e.target.value))}
                    className="border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded-xl px-3 py-1.5 w-20 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                  <button onClick={() => createInvite.mutate()}
                    className="bg-green-600 text-white px-4 py-1.5 rounded-xl text-sm hover:bg-green-700 transition-colors font-medium">
                    + Yeni Kod
                  </button>
                </div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm overflow-hidden">
                {codes?.map((c: any) => (
                  <div key={c.id} className="flex items-center justify-between px-4 py-3 border-b border-gray-50 dark:border-gray-700/50 last:border-0">
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-sm font-semibold text-gray-800 dark:text-gray-200 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded">{c.code}</span>
                      <span className="text-sm text-gray-500 dark:text-gray-400">{c.use_count}/{c.max_uses} kullanım</span>
                      {!c.is_active && <span className="text-xs text-red-400 bg-red-50 dark:bg-red-900/20 px-2 py-0.5 rounded-full">Deaktif</span>}
                    </div>
                    {c.is_active && (
                      <button onClick={() => deleteInvite.mutate(c.id)}
                        className="text-sm text-red-400 hover:text-red-600 hover:underline transition-colors">
                        Deaktif Et
                      </button>
                    )}
                  </div>
                ))}
                {!codes?.length && <p className="px-4 py-8 text-center text-sm text-gray-400">Davet kodu yok</p>}
              </div>
            </div>
          )}
          {activeTab === "logs" && (() => {
            const filterLower = logFilter.toLowerCase();
            const filtered = [...(logs || [])]
              .reverse()
              .filter(e => (logLevel === "ALL" || e.level === logLevel) && (!filterLower || e.msg.toLowerCase().includes(filterLower)));
            return (
              <div className="p-4 sm:p-6 flex flex-col gap-3 h-full overflow-hidden">
                {/* Header row */}
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Ingestion Logları</h2>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {filtered.length}/{(logs || []).length} satır · {logsUpdatedAt ? new Date(logsUpdatedAt).toLocaleTimeString("tr-TR") : "—"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={() => resetStatus.mutate()}
                      disabled={resetStatus.isPending}
                      className="text-xs px-3 py-1.5 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors border border-red-200 dark:border-red-800"
                      title="Takılı kalan 'İşleniyor' durumunu sıfırlar"
                    >
                      ⚠ Durumu Sıfırla
                    </button>
                    <button
                      onClick={() => qc.invalidateQueries({ queryKey: ["ingestion-logs"] })}
                      className="text-xs px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                    >
                      ↻ Yenile
                    </button>
                  </div>
                </div>

                {/* Filters */}
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    type="text"
                    placeholder="Grup adı veya mesaj ara..."
                    value={logFilter}
                    onChange={e => setLogFilter(e.target.value)}
                    className="flex-1 min-w-[180px] px-3 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                  {(["ALL", "INFO", "WARN", "ERROR"] as const).map(lvl => (
                    <button
                      key={lvl}
                      onClick={() => setLogLevel(lvl)}
                      className={`text-xs px-2.5 py-1.5 rounded-lg transition-colors ${logLevel === lvl
                        ? lvl === "ERROR" ? "bg-red-500 text-white"
                          : lvl === "WARN" ? "bg-yellow-500 text-white"
                          : lvl === "INFO" ? "bg-green-500 text-white"
                          : "bg-gray-700 text-white"
                        : "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"}`}
                    >
                      {lvl}
                    </button>
                  ))}
                </div>

                {/* Log output */}
                <div className="flex-1 overflow-y-auto bg-gray-900 dark:bg-black rounded-xl border border-gray-700 dark:border-gray-800 p-3 font-mono text-xs leading-5">
                  {!filtered.length && (
                    <p className="text-gray-500 italic p-2">{logs?.length ? "Filtre eşleşmedi." : "Henüz log yok."}</p>
                  )}
                  {filtered.map((entry, i) => {
                    const levelCls = entry.level === "ERROR" ? "text-red-400" : entry.level === "WARN" ? "text-yellow-400" : "text-green-400";
                    const time = new Date(entry.ts).toLocaleTimeString("tr-TR", { hour12: false, timeZone: "Europe/Berlin" });
                    const dateStr = new Date(entry.ts).toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit", timeZone: "Europe/Berlin" });
                    const highlighted = filterLower
                      ? entry.msg.replace(new RegExp(`(${filterLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "|||$1|||")
                      : entry.msg;
                    return (
                      <div
                        key={i}
                        className="grid grid-cols-[104px_54px_minmax(0,1fr)] gap-2 py-1.5 border-b border-gray-800 last:border-0 items-start"
                      >
                        <span className="text-gray-500 whitespace-nowrap">{dateStr} {time}</span>
                        <span className={`font-bold whitespace-nowrap ${levelCls}`}>{entry.level}</span>
                        <span className="text-gray-200 min-w-0 whitespace-pre-wrap break-words">
                          {highlighted.split("|||").map((part, j) =>
                            j % 2 === 1
                              ? <mark key={j} className="bg-yellow-400 text-black rounded px-0.5">{part}</mark>
                              : part
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </main>
      </div>
      <div className="text-center py-2 text-xs text-gray-400 dark:text-gray-600 select-none">
        v{import.meta.env.VITE_APP_VERSION || "dev"}
      </div>
    </div>
  );
}
