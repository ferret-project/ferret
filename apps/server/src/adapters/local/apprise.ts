/**
 * Notifications through apprise-api's stateless /notify endpoint: Ferret sends
 * the destination URL with every message, so the sidecar keeps nothing.
 * Plain fetch, so it runs on any runtime as it is.
 */
import type { Notifier } from "../../ports";

export class AppriseNotifier implements Notifier {
  constructor(private readonly baseUrl: string) {}

  async send(url: string, message: { title: string; body: string }) {
    let res: Response;
    try {
      res = await fetch(new URL("/notify/", this.baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ urls: url, title: message.title, body: message.body, type: "info", format: "text" }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new Error(`Couldn't reach Apprise at ${this.baseUrl} (${err instanceof Error ? err.message : String(err)})`, { cause: err instanceof Error ? (err.cause ?? err) : err });
    }
    if (res.ok) return;
    // Only these: Apprise's own wording would say whether some address and port answered, which isn't for
    // passing on.
    if (res.status === 400) throw new Error("Apprise doesn't recognise this URL");
    if (res.status === 424) throw new Error("The service didn't accept it — check the URL's address, token or topic");
    throw new Error(`Apprise answered ${res.status}`);
  }
}
