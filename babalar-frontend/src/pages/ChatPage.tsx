import { useState, useRef, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import api from "../api/client";
import { useAuthStore } from "../store/auth";
import { useThemeStore } from "../store/theme";
import AnswerFeedback from "../components/AnswerFeedback";

interface Source { group: string; date: string }
interface Message { role: "user" | "assistant"; text: string; sources?: Source[]; outOfScope?: boolean; traceId?: string; feedbackToken?: string }
interface Conversation { id: string; title: string; messages: Message[]; updatedAt: number }

const MAX_CONVS = 5;

function loadConversations(): Conversation[] {
  try { return JSON.parse(localStorage.getItem("babalar_convs") ?? "[]"); }
  catch { return []; }
}

function persistConversations(convs: Conversation[]) {
  localStorage.setItem("babalar_convs", JSON.stringify(convs));
}

function makeTitle(question: string): string {
  const trimmed = question.trim();
  return trimmed.length > 45 ? trimmed.slice(0, 45) + "…" : trimmed;
}

const CATEGORY_ICONS: Record<string, string> = {
  araba: "🚗", "resmi-daire": "🏛️", genel: "💬", sigorta: "🛡️",
  cocuk: "👶", bebek: "👶", yatırım: "📈", "is-kariyer": "💼",
  gayrimenkul: "🏠", konut: "🏠", futbol: "⚽", saglik: "🏥",
  "ikinci-el": "🛍️", egitim: "🎓", "spor-eglence": "⚽",
  "yemek-restoran": "🍽️", "steuer": "📋",
};
const catIcon = (cat: string) => {
  const k = Object.keys(CATEGORY_ICONS).find((k) => cat.toLowerCase().includes(k));
  return k ? CATEGORY_ICONS[k] : "📌";
};

const catLabel: Record<string, string> = {
  araba: "Araba", "resmi-daire": "Resmi Daire", genel: "Genel",
  cocuk: "Çocuk", bebek: "Bebek", "is-kariyer": "İş & Kariyer",
  konut: "Konut", saglik: "Sağlık", "ikinci-el": "İkinci El",
  egitim: "Eğitim", "spor-eglence": "Spor & Eğlence",
  "yemek-restoran": "Yemek & Restoran",
};

const SUGGESTED = [
  "Almanya'da TÜV nasıl yapılır?",
  "Yeni doğan bebek için ne yapmalıyım?",
  "Araba sigortası için ne önerirsiniz?",
  "Münih'te iyi döner nerede yenir?",
];

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
  const currentConvId = useRef<string | null>(null);

  // Question history navigation (like a terminal)
  const questionHistory = useRef<string[]>([]);
  const historyIdx = useRef<number>(-1);
  const historyDraft = useRef<string>("");

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    if (userMenuOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [userMenuOpen]);

  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const { theme, toggle } = useThemeStore();

  const { data: categories } = useQuery({
    queryKey: ["categories"],
    queryFn: () => api.get("/chat/categories").then((r) => r.data),
  });

  const { data: usage, refetch: refetchUsage } = useQuery({
    queryKey: ["chat-usage"],
    queryFn: () => api.get("/chat/usage").then((r) => r.data),
    refetchInterval: 60000,
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const startNewChat = useCallback(() => {
    setMessages([]);
    currentConvId.current = null;
    setSidebarOpen(false);
    historyIdx.current = -1;
    historyDraft.current = "";
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, []);

  const loadConversation = useCallback((conv: Conversation) => {
    setMessages(conv.messages);
    currentConvId.current = conv.id;
    setSidebarOpen(false);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, []);

  async function handleAsk(question: string) {
    if (!question.trim() || loading) return;
    setInput("");
    setSidebarOpen(false);
    historyIdx.current = -1;

    // Add to session history (deduplicate consecutive duplicates)
    const h = questionHistory.current;
    if (h[h.length - 1] !== question.trim()) {
      questionHistory.current = [...h, question.trim()].slice(-50);
    }

    const userMsg: Message = { role: "user", text: question };
    setMessages((m) => [...m, userMsg]);
    setLoading(true);

    // Build history from current messages (last 6 = 3 exchanges), convert text→content
    const history = messages.slice(-6).map((m) => ({ role: m.role, content: m.text }));

    let assistantMsg: Message;
    try {
      const res = await api.post("/chat/ask", { question, history });
      assistantMsg = {
        role: "assistant",
        text: res.data.answer,
        sources: res.data.sources,
        outOfScope: res.data.out_of_scope,
        traceId: res.data.trace_id,
        feedbackToken: res.data.feedback_token,
      };
    } catch (err: any) {
      const detail = err.response?.data?.detail || "Bir hata oluştu.";
      assistantMsg = { role: "assistant", text: `⚠️ ${detail}` };
    } finally {
      setLoading(false);
      textareaRef.current?.focus();
      refetchUsage();
    }

    setMessages((prev) => {
      const updated = [...prev, assistantMsg!];

      // Persist conversation
      setConversations((convs) => {
        let id = currentConvId.current;
        let title: string;

        if (!id) {
          id = crypto.randomUUID();
          currentConvId.current = id;
          title = makeTitle(question);
        } else {
          title = convs.find((c) => c.id === id)?.title ?? makeTitle(question);
        }

        const conv: Conversation = { id, title, messages: updated, updatedAt: Date.now() };
        const next = [conv, ...convs.filter((c) => c.id !== id)].slice(0, MAX_CONVS);
        persistConversations(next);
        return next;
      });

      return updated;
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAsk(input.trim());
      return;
    }

    const multiLine = input.includes("\n");
    const history = questionHistory.current;

    if (e.key === "ArrowUp" && !multiLine && history.length > 0) {
      e.preventDefault();
      if (historyIdx.current === -1) {
        historyDraft.current = input;
        historyIdx.current = history.length - 1;
      } else if (historyIdx.current > 0) {
        historyIdx.current--;
      }
      setInput(history[historyIdx.current]);
      return;
    }

    if (e.key === "ArrowDown" && !multiLine && historyIdx.current !== -1) {
      e.preventDefault();
      if (historyIdx.current === history.length - 1) {
        historyIdx.current = -1;
        setInput(historyDraft.current);
      } else {
        historyIdx.current++;
        setInput(history[historyIdx.current]);
      }
    }
  }

  const sidebarContent = (
    <div className="flex flex-col h-full">
      <div className="px-5 py-5 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-2">
          <img src="/logo.jpg" alt="Babalar" className="w-9 h-9 rounded-full object-cover flex-shrink-0" />
          <div>
            <p className="font-bold text-gray-900 dark:text-white text-lg leading-none">Babalar</p>
            <p className="text-gray-500 dark:text-gray-400 text-xs mt-0.5">Münih Topluluğu</p>
          </div>
        </div>
      </div>

      <div className="px-4 py-3">
        <button
          onClick={startNewChat}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        >
          <span>✏️</span> Yeni Sohbet
        </button>
      </div>

      {conversations.length > 0 && (
        <div className="px-4 pb-3">
          <p className="text-xs text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1.5 px-1">Son Sohbetler</p>
          <div className="space-y-0.5">
            {conversations.map((conv) => (
              <button
                key={conv.id}
                onClick={() => loadConversation(conv)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left transition-colors truncate ${
                  currentConvId.current === conv.id
                    ? "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white"
                    : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                }`}
              >
                <span className="flex-shrink-0 text-gray-400">💬</span>
                <span className="truncate">{conv.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="px-4 flex-1 overflow-y-auto border-t border-gray-200 dark:border-gray-800 pt-3">
        <p className="text-xs text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2 px-1">Konular</p>
        <div className="space-y-0.5">
          {categories?.map((c: { category: string; count: number }) => (
            <div
              key={c.category}
              className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-sm text-gray-500 dark:text-gray-400"
            >
              <span className="text-base leading-none">{catIcon(c.category)}</span>
              <span className="flex-1 text-left">{catLabel[c.category] ?? c.category}</span>
              <span className="text-xs opacity-40 tabular-nums">{c.count.toLocaleString("tr-TR")}</span>
            </div>
          ))}
        </div>
      </div>

      {!user?.is_admin && usage && (
        <div className="px-4 pb-4 pt-2 border-t border-gray-200 dark:border-gray-800">
          <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                usage.used / usage.limit >= 0.9 ? "bg-red-500"
                : usage.used / usage.limit >= 0.6 ? "bg-yellow-500"
                : "bg-green-500"
              }`}
              style={{ width: `${Math.min(100, (usage.used / usage.limit) * 100)}%` }}
            />
          </div>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Günlük {usage.limit} sorudan {usage.used} kullanıldı</p>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-950 overflow-hidden">
      {sidebarOpen && (
        <div className="fixed inset-0 z-20 bg-black/50 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <aside className={`
        fixed lg:static inset-y-0 left-0 z-30 w-64 flex-shrink-0
        bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800
        transform transition-transform duration-200
        ${sidebarOpen ? "translate-x-0" : "-translate-x-full"} lg:translate-x-0
      `}>
        {sidebarContent}
      </aside>

      <main className="flex-1 flex flex-col min-w-0 bg-gray-50 dark:bg-gray-950">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900/50">
          <button
            onClick={() => setSidebarOpen(true)}
            className="lg:hidden p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors flex-shrink-0"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900 dark:text-white">Münihli Babalar</p>
            <p className="text-xs text-gray-400 dark:text-gray-500 hidden sm:block">Topluluk bilgisinden yanıt üretilir</p>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={toggle}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              title={theme === "dark" ? "Açık mod" : "Koyu mod"}
            >
              {theme === "dark" ? "☀️" : "🌙"}
            </button>

            <div className="relative" ref={userMenuRef}>
              <button
                onClick={() => setUserMenuOpen((o) => !o)}
                className="flex items-center gap-2 pl-1.5 pr-2.5 py-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              >
                <div className="w-7 h-7 rounded-full bg-green-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
                  {user?.username?.[0]?.toUpperCase()}
                </div>
                <span className="hidden sm:block text-sm text-gray-700 dark:text-gray-300 max-w-[100px] truncate">
                  {user?.username}
                </span>
                <svg className="w-3.5 h-3.5 text-gray-400 hidden sm:block" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {userMenuOpen && (
                <div className="absolute right-0 top-full mt-1.5 w-44 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg py-1 z-50">
                  <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700">
                    <p className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">{user?.username}</p>
                    <p className="text-xs text-gray-400">{user?.is_admin ? "Admin · Limitsiz" : usage ? `${usage.used}/${usage.limit} soru` : ""}</p>
                  </div>
                  {user?.is_admin && (
                    <Link
                      to="/admin"
                      onClick={() => setUserMenuOpen(false)}
                      className="flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                    >
                      <span>⚙️</span> Ayarlar
                    </Link>
                  )}
                  <button
                    onClick={() => { setUserMenuOpen(false); logout(); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                  >
                    <span>↩️</span> Çıkış yap
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 space-y-5">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <div className="text-5xl mb-4">👨‍👦</div>
              <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-1">Babalar'a Sor</h2>
              <p className="text-gray-500 dark:text-gray-400 text-sm mb-8">Münihli Türk topluluğunun birikiminden yararlan</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-lg">
                {SUGGESTED.map((s) => (
                  <button
                    key={s}
                    onClick={() => handleAsk(s)}
                    className="text-left px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-700 text-sm text-gray-600 dark:text-gray-300 hover:border-green-500 hover:text-gray-900 dark:hover:text-white hover:bg-white dark:hover:bg-gray-800 transition-all"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              {msg.role === "assistant" && (
                <div className="w-8 h-8 rounded-full bg-green-600 flex-shrink-0 flex items-center justify-center text-sm mt-1 shadow-sm">👨‍👦</div>
              )}
              <div className={`max-w-xl lg:max-w-2xl flex flex-col gap-1 ${msg.role === "user" ? "items-end" : "items-start"}`}>
                <div className={`rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm ${
                  msg.role === "user"
                    ? "bg-green-600 text-white rounded-tr-sm"
                    : msg.outOfScope
                      ? "bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200 rounded-tl-sm border border-amber-200 dark:border-amber-800/50"
                      : "bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 rounded-tl-sm border border-gray-100 dark:border-transparent"
                }`}>
                  <p className="whitespace-pre-wrap">{msg.text}</p>
                  {msg.role === "assistant" && !msg.outOfScope && msg.sources && msg.sources.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700">
                      <p className="text-xs text-gray-400 font-medium uppercase tracking-wide mb-1.5">Kaynak gruplar</p>
                      <div className="flex flex-wrap gap-1.5">
                        {msg.sources.map((s, j) => (
                          <span key={j} className="inline-flex items-center gap-1 text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-0.5 rounded-full">
                            💬 {s.group}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                {msg.role === "assistant" && msg.traceId && msg.feedbackToken && <AnswerFeedback key={msg.traceId} traceId={msg.traceId} token={msg.feedbackToken} />}
              </div>
              {msg.role === "user" && (
                <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 flex-shrink-0 flex items-center justify-center text-sm font-bold text-gray-700 dark:text-white mt-1">
                  {user?.username?.[0]?.toUpperCase()}
                </div>
              )}
            </div>
          ))}

          {loading && (
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-green-600 flex-shrink-0 flex items-center justify-center text-sm">👨‍👦</div>
              <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-1.5 shadow-sm">
                {[0, 150, 300].map((d) => (
                  <span key={d} className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />
                ))}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="px-4 sm:px-6 py-4 border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900/50">
          <div className="flex items-end gap-3 bg-gray-50 dark:bg-gray-800 rounded-2xl px-4 py-3 border border-gray-200 dark:border-gray-700 focus-within:border-green-500 transition-colors">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                // Typing while browsing history detaches from history
                if (historyIdx.current !== -1) historyIdx.current = -1;
              }}
              onKeyDown={onKeyDown}
              placeholder="Sorunuzu yazın... (Enter gönderin, Shift+Enter yeni satır)"
              rows={1}
              disabled={loading}
              className="flex-1 bg-transparent text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 resize-none outline-none max-h-40 leading-relaxed disabled:opacity-50"
              style={{ fieldSizing: "content" } as any}
            />
            <button
              onClick={() => handleAsk(input.trim())}
              disabled={loading || !input.trim()}
              className="flex-shrink-0 w-8 h-8 rounded-xl bg-green-600 hover:bg-green-500 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
            >
              <svg className="w-4 h-4 text-white rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          </div>
          <p className="text-center text-xs text-gray-400 dark:text-gray-600 mt-2">
            Yanıtlar yalnızca topluluk mesajlarından üretilmektedir
          </p>
        </div>
      </main>
    </div>
  );
}
