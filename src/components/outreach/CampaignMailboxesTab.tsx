"use client";

import { useState } from "react";
import { RiAddLine, RiCloseLine, RiMailLine } from "@remixicon/react";

import * as Avatar from "@/components/alignui/avatar";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Checkbox from "@/components/alignui/checkbox";
import * as Modal from "@/components/alignui/modal";
import * as Table from "@/components/alignui/table";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { AccountIdentity, PresenceDot } from "@/components/settings/AccountsOverview";
import { Callout } from "@/components/settings/SettingsKit";
import type { mailboxes } from "@/lib/outreach/schema";
import { campaignMayUseMailbox } from "@/lib/outreach/campaignMailboxes";
import { cn } from "@/utils/cn";
import SignatureModal from "./SignatureModal";

type Mailbox = typeof mailboxes.$inferSelect;
export type OtherCampaign = { id: string; name: string; status: string; mailboxIds: string[] | null };

function initialsFor(mailbox: Mailbox) {
  const source = mailbox.displayName?.trim() || mailbox.emailAddress;
  const parts = source.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

/**
 * The campaign's sending mailboxes as a table: who sends, signature, the
 * other active campaigns on each mailbox, today's sends against its limit.
 * A campaign starts on every connected mailbox (mailboxIds null); removing
 * one or adding chosen ones turns that into an explicit list, and "Use all
 * mailboxes" goes back. Every change saves at once.
 */
export default function CampaignMailboxesTab({
  campaignId,
  mailboxIds,
  mailboxes: allMailboxes,
  otherCampaigns,
  onSaved,
}: {
  campaignId: string;
  mailboxIds: string[] | null;
  mailboxes: Mailbox[];
  otherCampaigns: OtherCampaign[];
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [signatureFor, setSignatureFor] = useState<Mailbox | null>(null);

  const usesAll = mailboxIds === null;
  const rows = allMailboxes.filter((m) => (usesAll ? m.status === "connected" : mailboxIds.includes(m.id)));
  const notInCampaign = allMailboxes.filter((m) => !rows.some((r) => r.id === m.id));
  const sending = rows.filter((m) => m.status === "connected");
  const dailyTotal = sending.reduce((sum, m) => sum + m.dailySendLimit, 0);
  const activeElsewhere = otherCampaigns.filter((c) => c.status === "active");

  async function save(next: string[] | null) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/outreach/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mailboxIds: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? "The change was not saved. Please try again.");
        return false;
      }
      onSaved();
      return true;
    } catch {
      setError("Could not reach the server. Please try again.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  function remove(id: string) {
    const remaining = rows.map((m) => m.id).filter((x) => x !== id);
    if (remaining.length === 0) {
      setError("A campaign needs at least one mailbox. Add another one before removing this one.");
      return;
    }
    void save(remaining);
  }

  return (
    <Frame>
      <FrameHeader
        title={
          <span className="inline-flex items-center gap-2">
            Email accounts
            <Badge.Root size="small" variant="lighter" color="green">
              <Badge.Dot />
              Sender rotation
            </Badge.Root>
          </span>
        }
        description={
          usesAll
            ? "Using every connected mailbox, including ones connected later. Remove a mailbox to keep it for other campaigns."
            : "Emails go out from these mailboxes only, in rotation."
        }
        actions={
          <>
            {!usesAll && (
              <Button.Root variant="neutral" mode="ghost" size="small" disabled={saving} onClick={() => void save(null)}>
                Use all mailboxes
              </Button.Root>
            )}
            <Button.Root
              variant="primary"
              mode="lighter"
              size="small"
              disabled={saving || notInCampaign.length === 0}
              onClick={() => setAdding(true)}
            >
              <Button.Icon as={RiAddLine} />
              Add email accounts
            </Button.Root>
          </>
        }
      />
      <FramePanel className={cn("overflow-x-auto p-2 sm:p-2", saving && "opacity-60")} aria-busy={saving || undefined}>
        {rows.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-label-sm text-text-strong-950">No mailboxes</p>
            <p className="mt-1 text-paragraph-sm text-text-sub-600">
              This campaign sends nothing new until you add a mailbox.
            </p>
          </div>
        ) : (
          <Table.Root className="min-w-190 [&>table]:table-fixed">
            <Table.Header>
              <Table.Row>
                <Table.Head scope="col" className="px-4">Sender email</Table.Head>
                <Table.Head scope="col" className="w-28 px-4">Signature</Table.Head>
                <Table.Head scope="col" className="w-36 px-4">Active campaigns</Table.Head>
                <Table.Head scope="col" className="w-32 px-4">Daily limit</Table.Head>
                <Table.Head scope="col" className="w-14 px-4"><span className="sr-only">Remove</span></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body spacing={4}>
              {rows.map((mailbox) => {
                const others = activeElsewhere.filter((c) => campaignMayUseMailbox(c.mailboxIds, mailbox.id));
                const connected = mailbox.status === "connected";
                return (
                  <Table.Row key={mailbox.id}>
                    <Table.Cell className="h-16 px-4">
                      <AccountIdentity
                        media={
                          <>
                            <Avatar.Root size="32" color="blue">{initialsFor(mailbox)}</Avatar.Root>
                            <PresenceDot ok={connected} />
                          </>
                        }
                        name={
                          <span className="truncate text-label-sm text-text-strong-950">
                            {mailbox.displayName || "No display name"}
                          </span>
                        }
                        detail={
                          <span title={mailbox.emailAddress}>
                            {mailbox.emailAddress}
                            {!connected && <span className="text-error-base"> · not connected</span>}
                          </span>
                        }
                      />
                    </Table.Cell>
                    <Table.Cell className="px-4">
                      <button
                        type="button"
                        onClick={() => setSignatureFor(mailbox)}
                        className="rounded text-label-sm text-primary-base outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary-base"
                      >
                        {mailbox.signatureHtml?.trim() ? "View" : "Add"}
                      </button>
                    </Table.Cell>
                    <Table.Cell className="px-4">
                      <span
                        className="text-paragraph-sm text-text-strong-950"
                        title={others.length ? `Also sending for: ${others.map((c) => c.name).join(", ")}` : "Only this campaign"}
                      >
                        {others.length + 1}
                        {others.length > 0 && <span className="text-paragraph-xs text-text-sub-600"> (shared)</span>}
                      </span>
                    </Table.Cell>
                    <Table.Cell className="px-4">
                      <span className="text-paragraph-sm text-text-strong-950" title="Sent today / daily limit">
                        {mailbox.todayEmailsSent}/{mailbox.dailySendLimit}
                      </span>
                    </Table.Cell>
                    <Table.Cell className="px-4">
                      <Button.Root
                        variant="neutral"
                        mode="ghost"
                        size="xsmall"
                        disabled={saving}
                        aria-label={`Remove ${mailbox.emailAddress} from this campaign`}
                        title="Remove from this campaign"
                        onClick={() => remove(mailbox.id)}
                      >
                        <Button.Icon as={RiCloseLine} />
                      </Button.Root>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table.Root>
        )}
      </FramePanel>
      <p className="px-4 pb-2 pt-2.5 text-paragraph-xs text-text-sub-600">
        {sending.length} {sending.length === 1 ? "mailbox" : "mailboxes"} · up to {dailyTotal.toLocaleString("en-US")} emails a day,
        shared with other campaigns on the same mailboxes. Leads that already started keep their mailbox, so follow-ups stay in
        the same thread; new leads follow this list from the next daily queue.
      </p>
      {error && (
        <div className="px-2 pb-2">
          <Callout tone="error">{error}</Callout>
        </div>
      )}

      {adding && (
        <AddMailboxesModal
          candidates={notInCampaign}
          activeElsewhere={activeElsewhere}
          onClose={() => setAdding(false)}
          onAdd={async (ids) => {
            if (await save([...rows.map((m) => m.id), ...ids])) setAdding(false);
          }}
          saving={saving}
        />
      )}
      {signatureFor && (
        <SignatureModal
          mailboxId={signatureFor.id}
          mailboxAddress={signatureFor.emailAddress}
          initial={signatureFor.signatureHtml}
          onClose={() => setSignatureFor(null)}
          onSaved={onSaved}
        />
      )}
    </Frame>
  );
}

function AddMailboxesModal({
  candidates,
  activeElsewhere,
  onClose,
  onAdd,
  saving,
}: {
  candidates: Mailbox[];
  activeElsewhere: OtherCampaign[];
  onClose: () => void;
  onAdd: (ids: string[]) => Promise<void>;
  saving: boolean;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const allPicked = picked.length === candidates.length;

  return (
    <Modal.Root open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content size="max-w-xl">
        <Modal.Header icon={RiMailLine}>
          <Modal.Title>Add email accounts</Modal.Title>
          <Modal.Description>Choose the mailboxes this campaign should also send from.</Modal.Description>
        </Modal.Header>
        <Modal.Body className="space-y-2">
          <label className="flex cursor-pointer items-center gap-3 px-3 py-1 text-label-sm text-text-strong-950">
            <Checkbox.Root checked={allPicked} onCheckedChange={() => setPicked(allPicked ? [] : candidates.map((m) => m.id))} />
            Select all ({candidates.length})
          </label>
          <div className="max-h-96 space-y-2 overflow-y-auto">
            {candidates.map((mailbox) => {
              const checked = picked.includes(mailbox.id);
              const others = activeElsewhere.filter((c) => campaignMayUseMailbox(c.mailboxIds, mailbox.id));
              return (
                <label
                  key={mailbox.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-xl p-3 ring-1 ring-inset transition",
                    checked ? "bg-bg-weak-50 ring-primary-base" : "ring-stroke-soft-200 hover:bg-bg-weak-50",
                  )}
                >
                  <Checkbox.Root
                    checked={checked}
                    onCheckedChange={() => setPicked((cur) => (checked ? cur.filter((x) => x !== mailbox.id) : [...cur, mailbox.id]))}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-label-sm text-text-strong-950">{mailbox.emailAddress}</span>
                    <span className="block truncate text-paragraph-xs text-text-sub-600">
                      {mailbox.displayName || "No display name"} · {mailbox.dailySendLimit} / day
                      {mailbox.status !== "connected" && <span className="text-error-base"> · not connected</span>}
                      {others.length > 0 && <> · in {others.map((c) => c.name).join(", ")}</>}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button.Root variant="neutral" mode="stroke" size="small" onClick={onClose}>
            Cancel
          </Button.Root>
          <Button.Root variant="primary" mode="filled" size="small" disabled={saving || picked.length === 0} onClick={() => void onAdd(picked)}>
            {saving ? "Adding..." : picked.length === 0 ? "Add mailboxes" : `Add ${picked.length} ${picked.length === 1 ? "mailbox" : "mailboxes"}`}
          </Button.Root>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
