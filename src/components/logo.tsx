import Image from "next/image";

/** The XAVAGE XXVI mark. The art is keyed to a black field, so in the light
 *  theme `.logo-mark` (globals.css) multiplies the key out against paper. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <Image
      src="/logo-mark.png"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      priority
      className="logo-mark shrink-0 select-none"
    />
  );
}
