/**
 * "Are you a person?" on the sign-up form (a Turnstile widget, when the server has one; a home Ferret has none). The
 * server says when there is one (/auth-options `humanCheck`); its widget hands back a one-use token, sent with the
 * sign-up as X-Turnstile-Token (lib/turnstile.ts on the server). After each try the widget is reset for a new one.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { useAppearance } from "./lib/appearance";

interface Turnstile {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<Turnstile> | undefined;
/** Turnstile's script, once per page (the CSP allows it only when the server has the check on). */
function loadTurnstile() {
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile didn't load")));
    script.onerror = () => {
      loading = undefined;
      reject(new Error("Turnstile didn't load"));
    };
    document.head.append(script);
  });
  return loading;
}

export interface HumanCheckHandle {
  /** A fresh check, after the token was used (or refused). */
  reset(): void;
}

export const HumanCheck = forwardRef<HumanCheckHandle, { siteKey: string; onToken: (token: string | null) => void }>(function HumanCheck({ siteKey, onToken }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const { dark } = useAppearance();
  const tokenTo = useRef(onToken);
  tokenTo.current = onToken;

  useImperativeHandle(ref, () => ({
    reset() {
      tokenTo.current(null);
      if (widget.current) window.turnstile?.reset(widget.current);
    },
  }));

  useEffect(() => {
    let gone = false;
    void loadTurnstile()
      .then((turnstile) => {
        if (gone || !box.current) return;
        widget.current = turnstile.render(box.current, {
          sitekey: siteKey,
          action: "signup",
          theme: dark ? "dark" : "light",
          size: "flexible",
          callback: (token: string) => tokenTo.current(token),
          "expired-callback": () => tokenTo.current(null),
          "error-callback": () => tokenTo.current(null),
        });
      })
      .catch(() => tokenTo.current(null));
    return () => {
      gone = true;
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey, dark]);

  return <div ref={box} className="min-h-[65px]" />;
});
