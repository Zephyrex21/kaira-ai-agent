import React, { useEffect, useRef } from "react";
import { ScrollText, X, Trash2, User, Sparkles } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

export interface TranscriptEntry {
  id: string;
  role: "user" | "model";
  text: string;
}

interface TranscriptPanelProps {
  isOpen: boolean;
  onClose: () => void;
  entries: TranscriptEntry[];
  onClear: () => void;
  themeColor: string;
}

/** Same theme→glow mapping used across SettingsPanel / MemoryDashboard. */
function getThemeBadgeGlow(themeColor: string) {
  switch (themeColor) {
    case "violet": return "border-purple-500/30 text-purple-400 bg-purple-500/10";
    case "crimson": return "border-rose-500/30 text-rose-400 bg-rose-500/10";
    case "emerald": return "border-emerald-500/30 text-emerald-400 bg-emerald-500/10";
    case "celestial": return "border-sky-500/30 text-sky-400 bg-sky-500/10";
    case "gold": return "border-amber-500/30 text-amber-400 bg-amber-500/10";
    case "rose": return "border-pink-500/30 text-pink-400 bg-pink-500/10";
    case "charcoal":
    default:
      return "border-indigo-500/30 text-indigo-400 bg-indigo-500/10";
  }
}

export function TranscriptPanel({ isOpen, onClose, entries, onClear, themeColor }: TranscriptPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest line whenever the log grows while open.
  useEffect(() => {
    if (isOpen && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [isOpen, entries.length, entries[entries.length - 1]?.text]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop Overlay — identical to MemoryDashboard/SettingsPanel */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/60 z-40 backdrop-blur-sm"
          />

          {/* Slide-over Container — identical shell to MemoryDashboard/SettingsPanel */}
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="absolute inset-y-0 right-0 w-full max-w-lg bg-[#020206]/95 border-l border-white/15 backdrop-blur-2xl z-50 flex flex-col shadow-[0_0_50px_rgba(0,0,0,0.8)]"
          >
            {/* Header */}
            <div className="p-6 border-b border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`p-2.5 rounded-xl border ${getThemeBadgeGlow(themeColor)}`}>
                  <ScrollText size={22} />
                </div>
                <div>
                  <h3 className="font-display font-medium text-lg tracking-tight text-white">
                    Conversation Log
                  </h3>
                  <p className="text-[10px] font-mono uppercase tracking-widest text-slate-400 mt-0.5">
                    This session only &middot; not saved to disk
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {entries.length > 0 && (
                  <button
                    onClick={onClear}
                    title="Clear transcript"
                    className="p-2 rounded-xl border border-white/5 bg-white/5 hover:bg-rose-500/10 hover:border-rose-500/30 text-slate-400 hover:text-rose-300 transition cursor-pointer"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
                <button
                  onClick={onClose}
                  className="p-2 rounded-xl border border-white/5 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition cursor-pointer"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* Scrollable transcript body */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-3">
              {entries.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center gap-2 opacity-40">
                  <ScrollText size={28} className="text-slate-500" />
                  <span className="text-xs font-mono text-slate-500 uppercase tracking-widest">
                    Nothing said yet this session
                  </span>
                </div>
              ) : (
                entries.map((entry) => (
                  <div
                    key={entry.id}
                    className={`flex gap-2.5 ${entry.role === "user" ? "flex-row-reverse text-right" : "text-left"}`}
                  >
                    <div
                      className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center border ${
                        entry.role === "user"
                          ? "border-white/10 bg-white/5 text-slate-300"
                          : "border-cyan-500/25 bg-cyan-500/10 text-cyan-300"
                      }`}
                    >
                      {entry.role === "user" ? <User size={13} /> : <Sparkles size={13} />}
                    </div>
                    <div
                      className={`max-w-[80%] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed ${
                        entry.role === "user"
                          ? "bg-white/5 border border-white/10 text-slate-200"
                          : "bg-cyan-500/5 border border-cyan-500/15 text-cyan-50"
                      }`}
                    >
                      {entry.text}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Footer status bar — mirrors MemoryDashboard/SettingsPanel */}
            <div className="px-6 py-3 border-t border-white/5 bg-white/5 flex items-center justify-between">
              <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500">
                {entries.length} line{entries.length === 1 ? "" : "s"}
              </span>
              <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500">
                Kaira V2
              </span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
