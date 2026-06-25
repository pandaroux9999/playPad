import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { X, Globe, Lock, Crown, Trash2 } from "lucide-react";
import { StarRating } from "./StarRating";
import { PlatformBadge } from "./PlatformBadge";
import { STATUS_OPTIONS, STATUS_CONFIG } from "@/lib/playpad-config";
import {
  upsertUserGame, setRating, upsertReview, setTopThree, getGameBySlug,
  type GameStatus,
} from "@/lib/library.functions";

type Props = {
  gameId: string;
  slug: string;
  name: string;
  cover_url: string | null;
  platform?: string;
  status?: GameStatus | null;
  rating?: number | null;
  reviewBody?: string;
  isReviewPublic?: boolean;
  topPosition?: number | null;
  onClose: () => void;
};

export function GameSheet(p: Props) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<GameStatus | null>(p.status ?? null);
  const [rating, setLocalRating] = useState<number>(p.rating ?? 0);
  const [reviewBody, setReviewBody] = useState(p.reviewBody ?? "");
  const [isPublic, setIsPublic] = useState(p.isReviewPublic ?? true);

  const upsert = useServerFn(upsertUserGame);
  const rate = useServerFn(setRating);
  const review = useServerFn(upsertReview);
  const top = useServerFn(setTopThree);
  const getBySlug = useServerFn(getGameBySlug);

  const { data: details } = useQuery({
    queryKey: ["game", p.slug],
    queryFn: () => getBySlug({ data: { slug: p.slug } }),
    staleTime: 60_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["mylib"] });
    qc.invalidateQueries({ queryKey: ["game", p.slug] });
  };

  const setStatusMut = useMutation({
    mutationFn: (s: GameStatus | null) => upsert({ data: { gameId: p.gameId, status: s } }),
    onSuccess: invalidate,
  });
  const rateMut = useMutation({
    mutationFn: (r: number) => rate({ data: { gameId: p.gameId, rating: r === 0 ? null : r } }),
    onSuccess: invalidate,
  });
  const reviewMut = useMutation({
    mutationFn: () => review({ data: { gameId: p.gameId, body: reviewBody, isPublic } }),
    onSuccess: invalidate,
  });
  const topMut = useMutation({
    mutationFn: (pos: 1 | 2 | 3 | null) => top({ data: { gameId: p.gameId, position: pos } }),
    onSuccess: invalidate,
  });

  return (
    <div className="fixed inset-0 z-50">
      <div className="sheet-overlay absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={p.onClose} />
      <div className="sheet-panel absolute inset-x-0 bottom-0 max-h-[92%] overflow-y-auto rounded-t-[28px] bg-card no-scrollbar">
        <div className="relative h-48 flex-shrink-0">
          {p.cover_url && <img src={p.cover_url} alt={p.name} className="h-full w-full object-cover" />}
          <div className="absolute inset-0 bg-gradient-to-t from-card via-card/40 to-transparent" />
          <button onClick={p.onClose} className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full bg-black/60 text-white backdrop-blur">
            <X size={18} />
          </button>
          <div className="absolute bottom-3 left-4 right-4">
            <div className="mb-2 flex items-center gap-2">
              {p.platform && <PlatformBadge platform={p.platform as never} />}
              {details?.avg != null && (
                <span className="rounded-md bg-black/50 px-2 py-0.5 text-[10px] font-mono text-amber-400">
                  ★ {details.avg.toFixed(1)} ({details.ratingCount})
                </span>
              )}
            </div>
            <h2 className="font-display text-2xl font-black text-white">{p.name}</h2>
          </div>
        </div>

        <div className="space-y-5 p-5 pb-10">
          {/* Status */}
          <div>
            <h3 className="mb-2 text-[10px] font-black uppercase tracking-widest text-muted-foreground">Statut</h3>
            <div className="flex flex-wrap gap-2">
              {STATUS_OPTIONS.map((s) => {
                const cfg = STATUS_CONFIG[s];
                const active = status === s;
                return (
                  <button
                    key={s}
                    onClick={() => { setStatus(s); setStatusMut.mutate(s); }}
                    className="rounded-xl px-3 py-1.5 text-xs font-bold"
                    style={active
                      ? { background: cfg.color, color: "#fff" }
                      : { background: "rgba(26,26,46,0.7)", color: "#8888aa" }}
                  >
                    {cfg.label}
                  </button>
                );
              })}
              {status !== null && (
                <button
                  onClick={() => { setStatus(null); setStatusMut.mutate(null); }}
                  className="flex items-center gap-1 rounded-xl px-3 py-1.5 text-xs font-bold text-red-400 bg-red-500/10"
                >
                  <Trash2 size={12} /> Retirer
                </button>
              )}
            </div>
          </div>

          {/* Rating */}
          <div>
            <h3 className="mb-2 text-[10px] font-black uppercase tracking-widest text-muted-foreground">Ma note</h3>
            <StarRating rating={rating} size={28} onChange={(r) => { setLocalRating(r); rateMut.mutate(r); }} />
          </div>

          {/* Review */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Ma critique</h3>
              <button
                onClick={() => setIsPublic((v) => !v)}
                className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-bold ${isPublic ? "text-green-400 bg-green-500/10" : "text-amber-400 bg-amber-500/10"}`}
              >
                {isPublic ? <Globe size={10} /> : <Lock size={10} />}
                {isPublic ? "Public" : "Privé"}
              </button>
            </div>
            <textarea
              value={reviewBody}
              onChange={(e) => setReviewBody(e.target.value)}
              placeholder="Écris ton avis…"
              rows={4}
              className="w-full rounded-xl border border-border bg-secondary/60 px-3 py-2 text-sm outline-none focus:border-[color:var(--brand-1)]"
            />
            <button
              onClick={() => reviewMut.mutate()}
              disabled={reviewMut.isPending}
              className="mt-2 w-full rounded-xl brand-gradient px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
            >
              {reviewMut.isPending ? "Enregistrement…" : "Enregistrer la critique"}
            </button>
          </div>

          {/* Top 3 */}
          <div>
            <h3 className="mb-2 flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-muted-foreground">
              <Crown size={11} className="text-amber-400" /> Top 3
            </h3>
            <div className="flex gap-2">
              {[1, 2, 3].map((pos) => (
                <button
                  key={pos}
                  onClick={() => topMut.mutate(p.topPosition === pos ? null : (pos as 1 | 2 | 3))}
                  className="flex-1 rounded-xl py-2 text-xs font-bold"
                  style={p.topPosition === pos
                    ? { background: "linear-gradient(135deg,#8B5CF6,#3B82F6)", color: "#fff" }
                    : { background: "rgba(26,26,46,0.7)", color: "#8888aa" }}
                >
                  #{pos}
                </button>
              ))}
            </div>
          </div>

          {/* Community reviews */}
          {details?.reviews && details.reviews.length > 0 && (
            <div>
              <h3 className="mb-2 text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                Critiques communauté ({details.reviews.length})
              </h3>
              <div className="space-y-2">
                {details.reviews.slice(0, 10).map((r) => (
                  <div key={r.id} className="rounded-xl border border-border bg-secondary/40 p-3">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-xs font-bold">{r.profile?.display_name ?? r.profile?.username ?? "Anonyme"}</span>
                      {r.rating != null && <span className="text-[10px] font-mono text-amber-400">★ {r.rating}</span>}
                    </div>
                    {r.body && <p className="text-xs text-muted-foreground">{r.body}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
