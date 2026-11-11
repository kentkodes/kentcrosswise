// Geist and Geist Mono via next/font/google: self-hosted at build time, no runtime request to Google.
// Both are variable fonts, so no weight list is given; the CSS uses 400, 500 and 600.
import { Geist, Geist_Mono } from "next/font/google";
import localFont from "next/font/local";

export const geistSans = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

export const geistMono = Geist_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

// Rosarivo Regular, self-hosted (OFL, see src/fonts/rosarivo/). Used only by the /office Room card, which mounts
// the connected room in a Rosarivo scope.
export const rosarivo = localFont({
  src: "../../../fonts/rosarivo/Rosarivo-Regular.ttf",
  weight: "400",
  style: "normal",
  display: "swap",
  variable: "--font-rosarivo",
  fallback: ["Georgia", "Times New Roman", "serif"],
});
