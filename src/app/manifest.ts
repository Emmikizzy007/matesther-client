import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Matesther ERP - Uniform Production & Business Management",
    short_name: "Matesther",
    description: "Manage Matesther uniform orders and production.",
    id: "/",
    start_url: "/login",
    scope: "/",
    display: "standalone",
    background_color: "#071f13",
    theme_color: "#0a3520",
    icons: [
      { src: "/api/branding/logo?size=192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/api/branding/logo?size=512", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
