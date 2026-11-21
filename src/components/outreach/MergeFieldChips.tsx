"use client";

import { useEffect, useMemo, useState } from "react";
import { RiArrowDownSLine, RiArrowLeftSLine, RiBracesLine, RiQuillPenLine, RiSearchLine } from "@remixicon/react";

import * as Button from "@/components/alignui/button";
import * as Popover from "@/components/alignui/popover";
import { STANDARD_MERGE_FIELDS, mergeFieldToken, type CampaignMergeField } from "@/lib/outreach/mergeFields";

/** Shown until the campaign's fields load. */
const DEFAULT_FIELDS: CampaignMergeField[] = STANDARD_MERGE_FIELDS.map((f) => ({ ...f, missing: 0 }));

/**
 * The toolbar above a subject/body field: "Insert field" opens a searchable
 * list of {{mergeFields}}, "Signature" inserts %signature%, and a hint for
 * {A|B} spin text. Inserts at the field's cursor (or over a selection) rather
 * than appending.
 *
 * The list always has the standard fields (first name, company, ...) and then
 * every column of the campaign's uploaded CSV/XLSX, each with how many leads
 * lack it. Choosing one asks for optional fallback text, inserted as
 * {{key|fallback}} and sent to leads without a value.
 */
export default function MergeFieldChips({
  campaignId,
  targetRef,
  value,
  onChange,
}: {
  campaignId: string;
  targetRef: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  value: string;
  onChange: (next: string) => void;
}) {
  const [fields, setFields] = useState<CampaignMergeField[]>(DEFAULT_FIELDS);
  const [totalLeads, setTotalLeads] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The field chosen from the list, waiting for its fallback text.
  const [chosen, setChosen] = useState<CampaignMergeField | null>(null);
  const [fallback, setFallback] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/outreach/campaigns/${campaignId}/merge-fields`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.fields?.length) return;
        setFields(data.fields as CampaignMergeField[]);
        setTotalLeads(typeof data.totalLeads === "number" ? data.totalLeads : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  const matches = useMemo(() => {
    const term = query.trim().toLowerCase();
    return term ? fields.filter((f) => f.token.toLowerCase().includes(term) || f.label.toLowerCase().includes(term)) : fields;
  }, [fields, query]);

  function close() {
    setOpen(false);
    setQuery("");
    setChosen(null);
    setFallback("");
  }

  function choose(field: CampaignMergeField) {
    setChosen(field);
    setFallback(field.token === "firstName" ? "there" : "");
  }

  function insertChosen() {
    if (!chosen) return;
    insert(mergeFieldToken(chosen.token, fallback));
    close();
  }

  function insert(token: string) {
    const el = targetRef.current;
    if (!el) {
      onChange(value + token);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next);
    // Restore focus + caret after the inserted token once React re-renders.
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <Popover.Root open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <Popover.Trigger asChild>
          <Button.Root variant="neutral" mode="stroke" size="xsmall">
            <Button.Icon as={RiBracesLine} />
            Insert field
            <span className="tabular-nums text-text-soft-400">{fields.length}</span>
            <Button.Icon as={RiArrowDownSLine} />
          </Button.Root>
        </Popover.Trigger>
        {/* Keep focus in the email field after inserting, not on the trigger. */}
        <Popover.Content align="start" sideOffset={6} showArrow={false} className="w-72 p-1.5" onCloseAutoFocus={(e) => e.preventDefault()}>
          {chosen ? (
            <FallbackStep
              field={chosen}
              totalLeads={totalLeads}
              fallback={fallback}
              onFallbackChange={setFallback}
              onBack={() => setChosen(null)}
              onInsert={insertChosen}
            />
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-stroke-soft-200 px-2 pb-2 pt-1">
                <RiSearchLine className="size-4 shrink-0 text-text-soft-400" aria-hidden="true" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search fields…"
                  aria-label="Search merge fields"
                  className="min-w-0 flex-1 bg-transparent text-paragraph-sm text-text-strong-950 outline-none placeholder:text-text-soft-400"
                />
              </div>
              <ul className="mt-1 max-h-72 overflow-y-auto">
                {matches.length === 0 ? (
                  <li className="px-2 py-6 text-center text-paragraph-xs text-text-sub-600">No field matches “{query}”.</li>
                ) : (
                  matches.map((f) => (
                    <li key={f.token}>
                      <button
                        type="button"
                        onClick={() => choose(f)}
                        className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left outline-none transition hover:bg-bg-weak-50 focus-visible:bg-bg-weak-50"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-paragraph-sm text-text-strong-950">{f.label}</span>
                          {totalLeads !== null && f.missing > 0 && (
                            <span className="block text-[11px] text-warning-base">
                              {f.missing === totalLeads ? "No lead has it" : `Missing for ${f.missing} of ${totalLeads}`}
                            </span>
                          )}
                        </span>
                        <span className="max-w-36 shrink-0 truncate font-mono text-[11px] text-text-soft-400">{`{{${f.token}}}`}</span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </>
          )}
        </Popover.Content>
      </Popover.Root>

      <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={() => insert("%signature%")} title="Replaced with the sending mailbox's signature">
        <Button.Icon as={RiQuillPenLine} />
        Signature
      </Button.Root>

      <span className="text-paragraph-xs text-text-soft-400">
        <span className="font-mono">{"{A|B}"}</span> picks one variant per lead
      </span>
    </div>
  );
}

/** Second step of the picker: optional text for leads without the field. */
function FallbackStep({
  field,
  totalLeads,
  fallback,
  onFallbackChange,
  onBack,
  onInsert,
}: {
  field: CampaignMergeField;
  totalLeads: number | null;
  fallback: string;
  onFallbackChange: (next: string) => void;
  onBack: () => void;
  onInsert: () => void;
}) {
  const coverage =
    totalLeads === null || totalLeads === 0
      ? "Leads without a value get the fallback text, or nothing if you leave it empty."
      : field.missing === 0
        ? `Every lead (${totalLeads}) has a value today. A fallback still covers leads you add later.`
        : field.missing === totalLeads
          ? `None of the ${totalLeads} leads has a value, so they all get the fallback text.`
          : `Missing for ${field.missing} of ${totalLeads} leads. They get the fallback text instead.`;

  return (
    // Not a <form>: React submit events bubble through the popover's portal,
    // so a nested form would also submit whatever form holds the editor.
    <div className="p-1.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to fields"
          className="rounded-md p-0.5 text-text-sub-600 hover:bg-bg-weak-50"
        >
          <RiArrowLeftSLine className="size-4" />
        </button>
        <span className="text-label-sm text-text-strong-950">{field.label}</span>
      </div>
      <p className="mt-1.5 text-paragraph-xs text-text-sub-600">{coverage}</p>
      <label className="mt-3 block text-label-xs text-text-strong-950" htmlFor="merge-fallback">
        Fallback if missing (optional)
      </label>
      <input
        id="merge-fallback"
        autoFocus
        value={fallback}
        onChange={(e) => onFallbackChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          onInsert();
        }}
        placeholder={field.token === "firstName" ? "there" : "e.g. your team"}
        className="mt-1 w-full rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-2.5 py-1.5 text-paragraph-sm text-text-strong-950 outline-none focus:border-primary-base placeholder:text-text-soft-400"
      />
      <p className="mt-2 truncate font-mono text-[11px] text-text-soft-400">
        Inserts {mergeFieldToken(field.token, fallback)}
      </p>
      <Button.Root type="button" variant="primary" mode="filled" size="xsmall" className="mt-3 w-full" onClick={onInsert}>
        Insert
      </Button.Root>
    </div>
  );
}
