"use client";

import { useState } from "react";
import { RiEditLine } from "@remixicon/react";

import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import * as Modal from "@/components/alignui/modal";
import { Callout, Field } from "@/components/settings/SettingsKit";
import { numberRule } from "@/lib/channels/rules";
import { MAX_DISPLAY_NAME_LENGTH } from "@/lib/outreach/mailboxSettings";
import type { WorkingHours } from "@/lib/outreach/schema";
import { capacityShortfall, describeShortfall, mailboxDayWindows } from "@/lib/outreach/sendWindow";

const LIMIT = numberRule("email", "dailySendLimit");

/**
 * A mailbox's own display name and daily limit. Both are set when the mailbox
 * is connected (the limit from the Sending rule at that moment); this is the
 * only place to change them afterwards.
 */
export default function MailboxSettingsModal({
  mailboxId,
  mailboxAddress,
  initialDisplayName,
  initialDailySendLimit,
  workingHours,
  sendGapMinutes,
  onClose,
  onSaved,
}: {
  mailboxId: string;
  mailboxAddress: string;
  initialDisplayName: string | null;
  initialDailySendLimit: number;
  /** The mailbox's hours and the organization's gap, to warn when the limit can't fit in them. */
  workingHours: WorkingHours;
  sendGapMinutes: [number, number];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState(initialDisplayName ?? "");
  const [limit, setLimit] = useState(String(initialDailySendLimit));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const limitNumber = Number(limit);
  const limitValid = limit.trim() !== "" && Number.isInteger(limitNumber) && limitNumber >= LIMIT.min && limitNumber <= LIMIT.max;
  const shortfall = limitValid ? capacityShortfall(mailboxDayWindows(workingHours), limitNumber, sendGapMinutes) : null;
  const risky = limitValid && LIMIT.safe?.above !== undefined && limitNumber > LIMIT.safe.above;

  async function handleSave() {
    if (!limitValid) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/outreach/mailboxes/${mailboxId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName, dailySendLimit: limitNumber }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? "The changes were not saved. Please try again.");
        return;
      }
      onSaved();
      onClose();
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal.Root open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content size="max-w-lg">
        <Modal.Header icon={RiEditLine}>
          <Modal.Title>Name and daily limit</Modal.Title>
          <Modal.Description>For {mailboxAddress}.</Modal.Description>
        </Modal.Header>
        <Modal.Body className="space-y-4">
          <Field
            label="Display name"
            htmlFor={`mailbox-name-${mailboxId}`}
            optional
            description="The name recipients see beside the address. Leave it empty to show the address alone."
          >
            <Input.Root size="medium">
              <Input.Wrapper>
                <Input.Input
                  id={`mailbox-name-${mailboxId}`}
                  type="text"
                  autoFocus
                  maxLength={MAX_DISPLAY_NAME_LENGTH}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Jane from Acme"
                />
              </Input.Wrapper>
            </Input.Root>
          </Field>

          <Field
            label="Emails per day"
            htmlFor={`mailbox-limit-${mailboxId}`}
            error={limitValid ? undefined : `Enter a whole number from ${LIMIT.min} to ${LIMIT.max}.`}
            description="Campaign emails and automatic CRM follow-ups from this mailbox share this limit. Changing the organization's Sending rule does not change it."
          >
            <Input.Root size="medium" className="w-40">
              <Input.Wrapper>
                <Input.Input
                  id={`mailbox-limit-${mailboxId}`}
                  type="number"
                  inputMode="numeric"
                  min={LIMIT.min}
                  max={LIMIT.max}
                  step={1}
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                />
              </Input.Wrapper>
            </Input.Root>
          </Field>

          {risky && LIMIT.warning && <Callout tone="warning">{LIMIT.warning}</Callout>}
          {shortfall && <Callout tone="warning">{describeShortfall(shortfall)}</Callout>}
          {error && <Callout tone="error">{error}</Callout>}
        </Modal.Body>
        <Modal.Footer>
          <Button.Root variant="neutral" mode="stroke" size="small" onClick={onClose}>
            Cancel
          </Button.Root>
          <Button.Root variant="primary" mode="filled" size="small" disabled={saving || !limitValid} onClick={handleSave}>
            {saving ? "Saving..." : "Save"}
          </Button.Root>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
