/**
 * Appearance — Automatic / Light / Dark — per device (public/appearance.js applies it before the page draws, and keeps
 * it in step with the device and with the help at /docs). This is React's view of it.
 */
import { useEffect, useState } from "react";

export type Appearance = "auto" | "light" | "dark";

declare global {
  interface Window {
    ferretAppearance?: { get: () => Appearance; set: (choice: Appearance) => void; isDark: () => boolean };
  }
}

const read = () => ({ choice: window.ferretAppearance?.get() ?? "auto", dark: window.ferretAppearance?.isDark() ?? false });

export function useAppearance() {
  const [state, setState] = useState(read);
  useEffect(() => {
    const update = () => setState(read());
    window.addEventListener("ferret:appearance", update);
    return () => window.removeEventListener("ferret:appearance", update);
  }, []);
  return { ...state, set: (choice: Appearance) => window.ferretAppearance?.set(choice) };
}
