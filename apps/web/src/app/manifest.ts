import type { MetadataRoute } from "next";

// Makes the site installable (iOS delivers web push only to a Home Screen web app).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Kentcrosswise",
    short_name: "Kentcrosswise",
    description: "A personal hub, built and maintained by AI agents.",
    start_url: "/hub",
    scope: "/",
    display: "standalone",
    background_color: "#0a0a0b",
    theme_color: "#0a0a0b",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
