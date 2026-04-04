/** Skeleton loading placeholders. */

export function SkeletonCard() {
  return (
    <div role="status" aria-label="Loading deal" style={{ padding: "10px 12px" }}>
      <div className="skeleton" style={{ height: 14, width: "60%", marginBottom: 8 }} />
      <div className="skeleton" style={{ height: 10, width: "80%", marginBottom: 8 }} />
      <div className="skeleton" style={{ height: 18, width: "100%" }} />
    </div>
  );
}

export function SkeletonDetail() {
  return (
    <div role="status" aria-label="Loading deal details" style={{ padding: 20 }}>
      <div className="skeleton" style={{ height: 20, width: "40%", marginBottom: 16 }} />
      <div className="skeleton" style={{ height: 12, width: "60%", marginBottom: 12 }} />
      <div className="skeleton" style={{ height: 12, width: "50%", marginBottom: 12 }} />
      <div className="skeleton" style={{ height: 12, width: "70%", marginBottom: 20 }} />
      <div className="skeleton" style={{ height: 80, width: "100%" }} />
    </div>
  );
}
