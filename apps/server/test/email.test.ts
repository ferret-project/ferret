import { describe, expect, it } from "vitest";
import { renderEmail } from "../src/lib/email";
import { AppriseNotifier } from "../src/adapters/local/apprise";

describe("Ferret's own emails", () => {
  const content = {
    subject: "Sam <3 invited you to Ann's \"House\"",
    heading: "Join <b>House</b>",
    greeting: "Hi <script>alert(1)</script>,",
    paragraphs: ["Sam keeps track of things at https://ferret.example.com/help."],
    action: { label: "Accept the invitation", url: "https://ferret.example.com/#/invite/abc?x=1&y=2", note: "It works until May 3." },
    sections: [{ heading: "Maintenance", items: [{ text: "Change <filter>", detail: "Due today", urgent: true }] }],
    footnote: "If you weren't expecting this, ignore it.",
  };

  it("escapes people's words, writes the link out under the button and links bare addresses", () => {
    const { title, html } = renderEmail(content);
    expect(title).toBe(content.subject);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>House");
    expect(html).not.toContain("<filter>");
    expect(html).toContain("Hi &lt;script&gt;alert(1)&lt;/script&gt;,");
    // The button and the written-out link, both with the &s escaped.
    expect(html.match(/href="https:\/\/ferret\.example\.com\/#\/invite\/abc\?x=1&amp;y=2"/g)).toHaveLength(2);
    expect(html).toContain(">https://ferret.example.com/#/invite/abc?x=1&amp;y=2</a>");
    expect(html).toContain('<a href="https://ferret.example.com/help"'); // the full stop isn't part of it
    expect(html).toContain("· Urgent");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain(">ferret.example.com</a>"); // the footer: which Ferret sent it
  });

  it("has a plain-text version of the same parts", () => {
    const { body } = renderEmail(content);
    expect(body).toBe(
      [
        "Hi <script>alert(1)</script>,",
        "Sam keeps track of things at https://ferret.example.com/help.",
        "Accept the invitation:\nhttps://ferret.example.com/#/invite/abc?x=1&y=2\nIt works until May 3.",
        "Maintenance\n• Change <filter> — Due today (urgent)",
        "If you weren't expecting this, ignore it.",
        "— Ferret · https://ferret.example.com",
      ].join("\n\n"),
    );
  });

  it("goes to Apprise as HTML for email addresses only", async () => {
    const posted: { body: string; format: string }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      posted.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const apprise = new AppriseNotifier("http://apprise.test:8000");
      const message = renderEmail(content);
      await apprise.send("mailtos://user:pass@mail.example.com?to=ann@example.com", message);
      await apprise.send("ntfy://ferret-topic", message);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(posted[0]!.format).toBe("html");
    expect(posted[0]!.body).toContain("<!doctype html>");
    expect(posted[1]!.format).toBe("text");
    expect(posted[1]!.body).not.toContain("<!doctype");
  });
});
