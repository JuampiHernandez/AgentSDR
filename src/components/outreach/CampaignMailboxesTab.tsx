"use client";

import { useState } from "react";

import * as Button from "@/components/alignui/button";
import * as Checkbox from "@/components/alignui/checkbox";
import * as SegmentedControl from "@/components/alignui/segmented-control";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { Callout } from "@/components/settings/SettingsKit";
import type { mailboxes } from "@/lib/outreach/schema";
import { campaignMayUseMailbox } from "@/lib/outreach/campaignMailboxes";
import { cn } from "@/utils/cn";

type Mailbox = typeof mailboxes.$inferSelect;
export type OtherCampaign = { id: string; name: string; status: string; mailboxIds: string[] | null };
type Mode = "all" | "chosen";

/**
 * Which mailboxes a campaign sends from: all connected ones (the default) or
 * a chosen few, so separate campaigns can run from separate mailboxes. Each
 * mailbox shows the other running campaigns that may use it.
 */
export default function CampaignMailboxesTab({
  campaignId,
  initialMailboxIds,
  mailboxes: allMailboxes,
  otherCampaigns,
  onSaved,
}: {
  campaignId: string;
  initialMailboxIds: string[] | null;
  mailboxes: Mailbox[];
  otherCampaigns: OtherCampaign[];
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<Mode>(initialMailboxIds === null ? "all" : "chosen");
  const [chosen, setChosen] = useState<string[]>(initialMailboxIds ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const connected = allMailboxes.filter((m) => m.status === "connected");
  const listed = [...connected, ...allMailboxes.filter((m) => m.status !== "connected")];
  const sending = mode === "all" ? connected : connected.filter((m) => chosen.includes(m.id));
  const dailyTotal = sending.reduce((sum, m) => sum + m.dailySendLimit, 0);
  const running = otherCampaigns.filter((c) => c.status === "active" || c.status === "paused");

  const initialKey = initialMailboxIds === null ? "all" : [...initialMailboxIds].sort().join(",");
  const currentKey = mode === "all" ? "all" : [...chosen].sort().join(",");
  const dirty = initialKey !== currentKey;
  const invalid = mode === "chosen" && chosen.length === 0;

  function toggle(id: string) {
    setSaved(false);
    setChosen((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/outreach/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mailboxIds: mode === "all" ? null : chosen }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? "The mailboxes were not saved. Please try again.");
        return;
      }
      setSaved(true);
      onSaved();
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Frame>
      <FrameHeader
        title="Sending mailboxes"
        description="Which mailboxes this campaign's emails go out from. Choose mailboxes to keep campaigns apart."
        actions={
          <SegmentedControl.Root
            value={mode}
            onValueChange={(v) => {
              setSaved(false);
              setMode(v as Mode);
            }}
          >
            <SegmentedControl.List className="w-auto">
              <SegmentedControl.Trigger value="all" className="px-3">All mailboxes</SegmentedControl.Trigger>
              <SegmentedControl.Trigger value="chosen" className="px-3">Choose mailboxes</SegmentedControl.Trigger>
            </SegmentedControl.List>
          </SegmentedControl.Root>
        }
      />
      <FramePanel className="space-y-4">
        {mode === "all" ? (
          <p className="text-paragraph-sm text-text-sub-600">
            Every connected mailbox can send for this campaign ({connected.length} now), shared with other campaigns
            that use all mailboxes. Mailboxes you connect later are included automatically.
          </p>
        ) : listed.length === 0 ? (
          <p className="text-paragraph-sm text-text-sub-600">No mailboxes yet. Connect one in Settings, Email, Mailboxes.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {listed.map((mailbox) => {
              const checked = chosen.includes(mailbox.id);
              const isConnected = mailbox.status === "connected";
              const sharedWith = running.filter((c) => campaignMayUseMailbox(c.mailboxIds, mailbox.id));
              return (
                <label
                  key={mailbox.id}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-xl p-3 ring-1 ring-inset transition",
                    checked ? "bg-bg-weak-50 ring-primary-base" : "ring-stroke-soft-200 hover:bg-bg-weak-50",
                  )}
                >
                  <Checkbox.Root className="mt-0.5" checked={checked} onCheckedChange={() => toggle(mailbox.id)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-label-sm text-text-strong-950" title={mailbox.emailAddress}>
                      {mailbox.emailAddress}
                    </span>
                    <span className="block truncate text-paragraph-xs text-text-sub-600">
                      {mailbox.displayName || "No display name"} · {mailbox.dailySendLimit} / day
                      {!isConnected && <span className="text-warning-base"> · not connected</span>}
                    </span>
                    {sharedWith.length > 0 && (
                      <span className="mt-0.5 block truncate text-paragraph-xs text-text-soft-400" title={sharedWith.map((c) => c.name).join(", ")}>
                        Also used by {sharedWith.map((c) => c.name).join(", ")}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        )}

        <p className="text-paragraph-xs text-text-sub-600">
          {sending.length} {sending.length === 1 ? "mailbox" : "mailboxes"} · up to {dailyTotal.toLocaleString("en-US")} emails a
          day, shared with any other campaign on the same mailboxes. Leads that already started keep their mailbox, so
          follow-ups stay in the same thread. New leads follow this choice from the next daily queue.
        </p>

        {invalid && <Callout tone="warning">Choose at least one mailbox, or switch to All mailboxes. With none, this campaign sends nothing new.</Callout>}
        {error && <Callout tone="error">{error}</Callout>}

        <div className="flex items-center justify-end gap-3">
          {saved && !dirty && <span className="text-paragraph-xs text-success-base">Saved</span>}
          <Button.Root variant="primary" mode="filled" size="small" disabled={!dirty || invalid || saving} onClick={handleSave}>
            {saving ? "Saving..." : "Save mailboxes"}
          </Button.Root>
        </div>
      </FramePanel>
    </Frame>
  );
}
