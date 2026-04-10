/** Draft approval panel — edit/approve/discard Dumont's outbound drafts. */

import { useState, useCallback } from "react";
import { Send, FileText } from "./Icons";

interface Draft {
  id: string; body: string; intent: string | null;
  channel: string; to: string | null;
  confidence: number | null; confidenceLevel: string | null;
  wasRevised?: boolean; originalBeforeRevision?: string | null;
  issues?: string[];
}

const LEVEL_COLORS: Record<string, string> = {
  high: "var(--green)", medium: "var(--amber)", low: "var(--osa-orange)", never: "var(--osa-red)",
};

interface Props {
  draft: Draft | null;
  onApprove: (draftId: string, editedBody?: string) => void;
  onDiscard: (draftId: string) => void;
}

export function DraftApproval({ draft, onApprove, onDiscard }: Props) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [showOriginal, setShowOriginal] = useState(false);

  const startEdit = useCallback(() => {
    if (!draft) return;
    setEditText(draft.body);
    setEditing(true);
  }, [draft]);

  const saveEdit = useCallback(() => {
    if (!draft) return;
    onApprove(draft.id, editText);
    setEditing(false);
  }, [draft, editText, onApprove]);

  const approve = useCallback(() => {
    if (!draft) return;
    onApprove(draft.id);
  }, [draft, onApprove]);

  const discard = useCallback(() => {
    if (!draft) return;
    onDiscard(draft.id);
  }, [draft, onDiscard]);

  if (!draft) return null;

  const levelColor = LEVEL_COLORS[draft.confidenceLevel ?? "low"] ?? "var(--text-muted)";

  return (
    <div aria-live="polite" aria-label="Draft approval" style={{
      padding: 12, borderRadius: 4, background: "var(--surface-hover)",
      border: "1px solid var(--border)", marginBottom: 12,
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <FileText size={14} color="var(--osa-orange)" />
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>Draft Ready</span>
          <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: levelColor, color: "#fff", fontWeight: 600 }}>
            {draft.confidenceLevel?.toUpperCase() ?? "LOW"}
          </span>
          {draft.wasRevised && (
            <button onClick={() => setShowOriginal(!showOriginal)} aria-label="Toggle original draft" style={{
              fontSize: 9, padding: "1px 5px", borderRadius: 4, border: "1px solid var(--amber)",
              background: "transparent", color: "var(--amber)", cursor: "pointer", fontFamily: "var(--font-mono)",
            }}>
              Evaluator revised
            </button>
          )}
        </div>
        <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          → {draft.to ?? "?"} via {draft.channel}
        </span>
      </div>

      {/* Issues from evaluator */}
      {draft.issues && draft.issues.length > 0 && (
        <div style={{ marginBottom: 8, fontSize: 11, color: "var(--amber)" }}>
          {draft.issues.map((issue, i) => <div key={i}>⚠ {issue}</div>)}
        </div>
      )}

      {/* Original before revision */}
      {showOriginal && draft.originalBeforeRevision && (
        <div style={{ marginBottom: 8, padding: 8, borderRadius: 4, background: "var(--surface)", fontSize: 11, color: "var(--text-muted)", borderLeft: "3px solid var(--amber)" }}>
          <div style={{ fontSize: 9, fontWeight: 600, marginBottom: 4 }}>ORIGINAL (before evaluator revision):</div>
          {draft.originalBeforeRevision}
        </div>
      )}

      {/* Draft body / edit textarea */}
      {editing ? (
        <textarea
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          aria-label="Edit draft text"
          onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); }}
          style={{
            width: "100%", minHeight: 80, padding: 8, borderRadius: 4,
            border: "1px solid var(--osa-orange)", background: "var(--surface)",
            color: "var(--text-primary)", fontSize: 12, fontFamily: "var(--font-sans)",
            resize: "vertical", outline: "none",
          }}
        />
      ) : (
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5, padding: "4px 0" }}>
          {draft.body}
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        {editing ? (
          <button onClick={saveEdit} aria-label="Save edit and send" style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 12px", borderRadius: 4, border: "none", background: "var(--osa-orange)", color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
            <Send size={12} /> Save & Send
          </button>
        ) : (
          <button onClick={approve} aria-label="Approve and send draft" style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 12px", borderRadius: 4, border: "none", background: "var(--green)", color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
            <Send size={12} /> Approve & Send
          </button>
        )}
        {!editing && (
          <button onClick={startEdit} aria-label="Edit draft" style={{ padding: "6px 12px", borderRadius: 4, border: "1px solid var(--border)", background: "transparent", color: "var(--text-secondary)", fontSize: 11, cursor: "pointer" }}>
            Edit
          </button>
        )}
        <button onClick={discard} aria-label="Discard draft" style={{ padding: "6px 12px", borderRadius: 4, border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", fontSize: 11, cursor: "pointer" }}>
          Discard
        </button>
      </div>
    </div>
  );
}
