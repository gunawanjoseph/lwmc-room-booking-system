export function StatusBadge({
  status,
  label,
}: {
  status: string;
  label?: string;
}) {
  return (
    <span
      className={`status-badge status-${status.replaceAll("_", "-")}`}
    >
      {label ?? status.replaceAll("_", " ")}
    </span>
  );
}
