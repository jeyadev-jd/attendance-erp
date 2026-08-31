import type { Metadata } from "next";
import "./globals.css";
import Providers from "./providers";

export const metadata: Metadata = {
  title: "Attendance Portal",
  description: "College attendance management system",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* Column layout so the footer sits below the content on short pages
          rather than floating mid-screen, and still scrolls on long ones. */}
      <body className="flex min-h-screen flex-col bg-slate-50 text-slate-900 antialiased">
        <div className="flex-1">
          <Providers>{children}</Providers>
        </div>
        <footer className="py-4 text-center text-xs text-slate-500">
          Developed by{" "}
          <a
            href="http://jeyadev.dev/"
            target="_blank"
            // noopener stops the opened page reaching back via window.opener;
            // noreferrer keeps the portal URL out of its referrer log.
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline"
          >
            Jeyadev R
          </a>{" "}
          E0324090
        </footer>
      </body>
    </html>
  );
}
