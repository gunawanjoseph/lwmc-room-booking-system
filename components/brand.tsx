import Link from "next/link";
import { DoorOpen } from "lucide-react";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="brand" aria-label="RoomOps home">
      <span className="brand-mark">
        <DoorOpen size={compact ? 18 : 21} strokeWidth={2.2} />
      </span>
      <span>RoomOps</span>
    </Link>
  );
}
