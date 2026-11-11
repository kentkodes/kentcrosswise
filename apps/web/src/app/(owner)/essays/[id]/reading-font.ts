// Newsreader for the essay body only (--font-reading). Headings and UI stay Geist; the variable class is applied to
// the article element alone (page.tsx). Next bundles next/font @font-face rules into a shared CSS chunk, so the
// declaration also reaches public pages; that is harmless (a browser downloads a font only when text uses it), but a
// preload would force the download everywhere, hence preload: false. The reader fetches it when the article renders.
import { Newsreader } from "next/font/google";

export const newsreader = Newsreader({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-reading",
  preload: false,
});
