import type { Metadata } from "next";
import "../styles.css";
export const metadata: Metadata = {
  title: "NexusFlow — Operations",
  description: "Distributed order processing and transaction operations.",
  icons: { icon: "/favicon.svg" },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
