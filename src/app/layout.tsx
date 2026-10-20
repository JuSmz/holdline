import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";

import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";

import "./globals.css";

// Self-hosted (next/font/local via the official `geist` package): builds need no network access.
const geistSans = GeistSans;
const geistMono = GeistMono;

export const metadata: Metadata = {
  title: {
    default: "Holdline — Answers the call. Books the job. Secures the payment.",
    template: "%s · Holdline",
  },
  description:
    "An AI phone agent for trades businesses. It answers every call, books the job at your fixed price and secures the payment with a PayPal hold while the caller is still on the line.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
