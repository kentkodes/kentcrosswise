// Geist and Geist Mono via next/font/google: self-hosted at build time, no runtime request to Google.
// Both are variable fonts, so no weight list is given; the CSS uses 400, 500 and 600.
import { Geist, Geist_Mono } from "next/font/google";

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
