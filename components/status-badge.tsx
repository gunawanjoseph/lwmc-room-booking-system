export function StatusBadge({
  status,
}: {
  status: string;
}) {
  return (
    <span
      className={`status-badge status-${status.replaceAll("_", "-")}`}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}
