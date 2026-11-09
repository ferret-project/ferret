import { translate, type Language } from "./i18n";

/** Presentation labels only: never use these strings as API values or database identifiers. */
export const labelSources: Record<string, string> = {
  new: "New", excellent: "Excellent", good: "Good", fair: "Fair", poor: "Poor",
  text: "Text", number: "Number", date: "Date", choice: "Choice",
  day: "day", week: "week", month: "month", year: "year",
  miles: "Miles", km: "Kilometres", hours: "Hours (engine, run time)", cycles: "Cycles (washes, uses)",
};
export const enumLabel = (value: string, language: Language = "en") => translate(language, labelSources[value] ?? value);
export const intervalLabel = (value: string, language: Language = "en") => translate(language, ({ day: "days", week: "weeks", month: "months", year: "years" } as Record<string, string>)[value] ?? value);
