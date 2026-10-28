import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Astro",
  description: "Simulador espacial sandbox para explorar sistemas astronômicos.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
