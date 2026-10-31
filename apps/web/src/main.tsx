import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import "./index.css";

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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
