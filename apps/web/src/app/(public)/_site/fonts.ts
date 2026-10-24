// Rosarivo Regular, self-hosted (OFL, see src/fonts/rosarivo/). Ranked lead face for the home page.
import localFont from "next/font/local";

export const rosarivo = localFont({
  src: "../../../fonts/rosarivo/Rosarivo-Regular.ttf",
  weight: "400",
  style: "normal",
  display: "swap",
  variable: "--font-rosarivo",
  fallback: ["Georgia", "Times New Roman", "serif"],
});

// PT Serif Regular (OFL, see src/fonts/pt-serif/), ranked by Impeccable font-match for the comp's
// lining figures. Limited to digits, comma and full stop, and stacked before Rosarivo only on
// numbers, so every letter stays Rosarivo.
export const figures = localFont({
  src: "../../../fonts/pt-serif/PT_Serif-Web-Regular.ttf",
  weight: "400",
  style: "normal",
  display: "swap",
  variable: "--font-figures",
  adjustFontFallback: false,
  declarations: [{ prop: "unicode-range", value: "U+0030-0039, U+002C, U+002E" }],
});
