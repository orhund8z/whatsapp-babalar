import { useState } from "react";
import { Check, LoaderCircle, ThumbsDown, ThumbsUp } from "lucide-react";
import api from "../api/client";

export default function AnswerFeedback({ traceId, token }: { traceId: string; token: string }) {
  const [value, setValue] = useState<0 | 1 | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function submit(next: 0 | 1) {
    setBusy(true);
    setError(false);
    try {
      await api.post("/chat/feedback", { trace_id: traceId, feedback_token: token, value: next });
      setValue(next);
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  return <div className="flex min-h-8 items-center gap-1 text-xs text-gray-400">
    {[1, 0].map(rating => {
      const label = rating ? "Yanıt faydalı" : "Yanıt faydalı değil";
      const Icon = rating ? ThumbsUp : ThumbsDown;
      return <button key={rating} title={label} aria-label={label} aria-pressed={value === rating}
        disabled={busy} onClick={() => submit(rating as 0 | 1)}
        className={`flex h-8 w-8 items-center justify-center rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 ${value === rating ? (rating ? "text-green-600" : "text-red-500") : "text-gray-400"}`}>
        <Icon size={15} />
      </button>;
    })}
    <span role="status" aria-live="polite" className="ml-1 flex items-center gap-1">
      {busy ? <LoaderCircle size={13} className="animate-spin" /> : error ? "Kaydedilemedi" : value !== null ? <><Check size={13} />Kaydedildi</> : null}
    </span>
  </div>;
}
