import Image from "next/image";
import Link from "next/link";

export function Brand({ compact = false }: { compact?: boolean }) {
  const size = compact ? 34 : 38;
  return (
    <Link
      href="/"
      className={`brand${compact ? " brand-compact" : ""}`}
      aria-label="RoomOps, Living Waters Methodist Church, home"
    >
      <Image
        className="brand-mark"
        src="/brand/lwmc-mark.png"
        alt=""
        width={size}
        height={size}
        priority
      />
      <span className="brand-text">
        <span className="brand-name">RoomOps</span>
        <span className="brand-org">Living Waters Methodist Church</span>
      </span>
    </Link>
  );
}

/** The full two-row church lockup: colour on light surfaces, white on navy. */
export function ChurchLockup({
  tone = "color",
  width = 220,
}: {
  tone?: "color" | "white";
  width?: number;
}) {
  const white = tone === "white";
  return (
    <Image
      className="church-lockup"
      src={white ? "/brand/lwmc-lockup-white.png" : "/brand/lwmc-lockup.png"}
      alt="Living Waters Methodist Church"
      width={width}
      height={Math.round(width * (white ? 271 / 720 : 283 / 720))}
      priority
    />
  );
}
