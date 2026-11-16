import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import "./index.css";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { startLanguage } from "./lib/i18n";
import { greetConsole } from "./lib/dook";
import { WarDance } from "./WarDance";
import { DocumentViewerHost } from "./DocumentViewer";
import { catchFileLinks } from "./lib/documents";

const queryClient = new QueryClient({
  // Once more after a failure — but not when the server said no (not found, not allowed): asking again won't change it.
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, err) => {
        const status = (err as Error & { status?: number }).status ?? 0;
        return count < 1 && !(status >= 400 && status < 500);
      },
    },
  },
});

// Push reminders, and the app's own files kept for offline capture (public/sw.js). Once loaded (and whenever the signal
// comes back), the worker refreshes its copy from the build's precache.json.
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js").catch(() => {});
  const refresh = () => {
    if (navigator.onLine) void navigator.serviceWorker.ready.then((r) => r.active?.postMessage("precache"));
  };
  window.addEventListener("load", refresh);
  window.addEventListener("online", refresh);
}

// The language first (lib/i18n.ts), so the first screen is already in it.
await startLanguage();
greetConsole();
catchFileLinks();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <WarDance />
        <DocumentViewerHost />
      </QueryClientProvider>
    </I18nProvider>
  </StrictMode>,
);
