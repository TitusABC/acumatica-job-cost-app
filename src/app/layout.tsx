import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Job Cost Analyst",
  description: "AI-powered job cost and profitability analysis",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="bg-gray-100 text-gray-900 antialiased">{children}</body>
    </html>
  );
}