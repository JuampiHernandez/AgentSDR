/**
 * The merge fields the sequence editor offers for a campaign. Client-safe:
 * no database imports, so it can be tested on plain variable bags.
 */

export type CampaignMergeField = {
  token: string;
  label: string;
  /** Leads in the campaign with no value for this field. */
  missing: number;
};

/**
 * Offered for every campaign, even before any lead has the value: a file
 * without a first-name column must still let you write {{firstName|there}}.
 */
export const STANDARD_MERGE_FIELDS: ReadonlyArray<{ token: string; label: string }> = [
  { token: "firstName", label: "First name" },
  { token: "lastName", label: "Last name" },
  { token: "fullName", label: "Full name" },
  { token: "company", label: "Company" },
  { token: "title", label: "Job title" },
  { token: "email", label: "Email" },
  { token: "companyDomain", label: "Company domain" },
];

// Second names personVariables gives a standard field. They resolve fine in a
// template, but listing them would show the same value twice.
const ALIASES = new Set(["name", "jobtitle", "companyname", "linkedin"]);

/**
 * The standard fields first, then every other key any lead has a value for
 * (the uploaded file's own columns), each with how many leads lack it.
 */
export function campaignMergeFields(leads: ReadonlyArray<Record<string, string>>): CampaignMergeField[] {
  const filled = (bag: Record<string, string>) => {
    const keys = new Set<string>();
    for (const [key, value] of Object.entries(bag)) if (value && value.trim()) keys.add(key.toLowerCase());
    return keys;
  };
  const filledPerLead = leads.map(filled);
  const missing = (token: string) => {
    const wanted = token.toLowerCase();
    return filledPerLead.filter((keys) => !keys.has(wanted)).length;
  };

  const standard = new Set(STANDARD_MERGE_FIELDS.map((f) => f.token.toLowerCase()));
  const extra: string[] = [];
  const seen = new Set<string>();
  for (const bag of leads) {
    for (const [key, value] of Object.entries(bag)) {
      const lower = key.toLowerCase();
      if (!value || !value.trim() || standard.has(lower) || ALIASES.has(lower) || seen.has(lower)) continue;
      seen.add(lower);
      extra.push(key);
    }
  }

  return [
    ...STANDARD_MERGE_FIELDS.map((f) => ({ ...f, missing: missing(f.token) })),
    ...extra.map((key) => ({ token: key, label: humanizeKey(key), missing: missing(key) })),
  ];
}

/** "jobTitle" -> "Job title", the inverse of leadImport's toCamelCaseKey. */
export function humanizeKey(key: string): string {
  const spaced = key.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** Strips what would end or break a {{key|fallback}} token. */
export function cleanFallback(text: string): string {
  return text.replace(/[{}\r\n]/g, " ").replace(/\s+/g, " ").trim();
}

/** The token to insert: {{key}}, or {{key|fallback}} when one is given. */
export function mergeFieldToken(token: string, fallback: string): string {
  const clean = cleanFallback(fallback);
  return clean ? `{{${token}|${clean}}}` : `{{${token}}}`;
}
