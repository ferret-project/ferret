import { t as translateText } from "./i18n";
/**
 * Say it instead of typing it (AI-7; server: POST /transcribe → the Speech port, a Whisper server): tap to record,
 * tap again (or wait 10 s) to stop; the words come back into the field. Shown only when the server has speech to text.
 * The recording goes to this Ferret server and its speech model, and isn't kept. It's sent as a small 16 kHz mono WAV
 * (decoded here from whatever the browser recorded — webm in Chrome, mp4 in Safari): every Whisper server reads WAV,
 * and some (vLLM's) read neither webm nor mp4.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "./lib/api";
import { useFeatures } from "./lib/features";

const MAX_MS = 10_000;
const TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

export function SpeakButton({ onText, label = translateText("Say it") }: { onText: (text: string) => void; label?: string }) {
  const features = useFeatures();
  const [state, setState] = useState<"idle" | "recording" | "reading">("idle");
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    recorder.current?.stream.getTracks().forEach((t) => t.stop());
  }, []);
  if (!features?.speech || typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) return null;

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timer.current) clearTimeout(timer.current);
        setState("reading");
        try {
          const recorded = new Blob(chunks, { type: rec.mimeType || mimeType || "audio/webm" });
          const { text } = await api.transcribe(await toWav(recorded).catch(() => recorded));
          if (text) onText(text.replace(/[.。!?]+$/, ""));
          else setError(translateText("Didn't catch that — try again"));
        } catch (err) {
          setError((err as Error).message);
        }
        setState("idle");
      };
      recorder.current = rec;
      rec.start();
      setState("recording");
      timer.current = setTimeout(() => rec.state === "recording" && rec.stop(), MAX_MS);
    } catch {
      setError(translateText("Ferret can't use the microphone — check the browser's permission"));
      setState("idle");
    }
  }

  return (
    <span className="flex shrink-0 flex-col items-end">
      <button
        type="button"
        className={`btn btn-square ${state === "recording" ? "btn-error" : "btn-soft btn-primary"}`}
        aria-label={state === "recording" ? translateText("Stop recording") : label}
        aria-pressed={state === "recording"}
        disabled={state === "reading"}
        onClick={() => (state === "recording" ? recorder.current?.stop() : void start())}
      >
        {state === "reading" ? (
          <span className="loading loading-spinner loading-sm" />
        ) : (
          <span className={`${state === "recording" ? "icon-[tabler--player-stop-filled]" : "icon-[tabler--microphone]"} size-5`} />
        )}
      </button>
      {error && (
        <span role="alert" className="mt-1 max-w-48 text-end text-xs text-error">
          {error}
        </span>
      )}
    </span>
  );
}

/** The recording as 16 kHz mono 16-bit WAV — what speech models listen at (10 s ≈ 320 KB). */
async function toWav(blob: Blob): Promise<Blob> {
  const rate = 16_000;
  const decoded = await new AudioContext().decodeAudioData(await blob.arrayBuffer());
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const samples = (await offline.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  out.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); // PCM
  out.setUint16(22, 1, true); // mono
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  text(36, "data");
  out.setUint32(40, samples.length * 2, true);
  samples.forEach((x, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x)) * 0x7fff, true));
  return new Blob([out], { type: "audio/wav" });
}
