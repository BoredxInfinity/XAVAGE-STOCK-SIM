import Image from "next/image";

/** The XAVAGE XXVI mark, keyed off its black field so it sits on any surface. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <Image
      src="/logo-mark.png"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      priority
      className="shrink-0 select-none"
    />
  );
}
