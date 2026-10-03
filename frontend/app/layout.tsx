import type { Metadata } from "next";
import "./globals.css";
import {CustomerProvider} from "@/components/customer-auth";

export const metadata: Metadata = {
  title: "NC Daily Blooms | Fresh Pooja Flowers in Bengaluru",
  description: "Fresh flower strings, roses and pooja garlands delivered in Vijayanagar, Chandra Layout and Basaveshwara Nagar. Enquire about today’s flower prices.",
  icons: {
    icon: "/favicon.png",
    shortcut: "/favicon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased"><CustomerProvider>{children}</CustomerProvider></body>
    </html>
  );
}
