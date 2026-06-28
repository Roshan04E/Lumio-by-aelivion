export function AiActivityIndicator({ label }: { label: string }) {
  return (
    <span aria-live="polite" className="ai-activity-indicator" role="status">
      <span className="ai-activity-dots">
        <i />
        <i />
        <i />
      </span>
      <span className="ai-activity-label">{label}</span>
    </span>
  );
}
