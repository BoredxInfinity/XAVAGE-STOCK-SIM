import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { Providers } from "@/components/providers";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-jb", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Xavage Trading Floor", template: "%s · Xavage" },
  description: "Live-market trading simulation for the Xavage competition.",
};

export const viewport: Viewport = {
  // The dark default; ThemeProvider rewrites the meta when the user flips.
  themeColor: "#06060c",
  width: "device-width",
  initialScale: 1,
};

/* Stamp the stored theme before first paint. Anything less than a blocking
   inline script here shows a dark flash to light-mode users on every
   navigation that hits the server. Keep the key in sync with THEME_KEY in
   src/components/theme-provider.tsx. */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("xavage-theme");if(t!=="light"&&t!=="dark")t="dark";var r=document.documentElement;r.dataset.theme=t;r.style.colorScheme=t;}catch(e){document.documentElement.dataset.theme="dark";}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="dark"
      suppressHydrationWarning
      className={`${inter.variable} ${mono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
        {/* Vercel Web Analytics. Cookieless and no identifiers: it records the
            path, and no route in this app carries a team or account id. Note
            the middleware matcher below excludes /_vercel, or the beacon is
            answered with a redirect to /login for anyone not signed in. */}
        <Analytics />
      </body>
    </html>
  );
}
