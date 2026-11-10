import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SmartRoute Engine",
  description: "Read-only Outreach map for Auckland North Shore",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
