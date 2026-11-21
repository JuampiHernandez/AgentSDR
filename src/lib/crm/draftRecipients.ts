/**
 * Who a CRM email draft goes to.
 *
 * Usually the record's Person. When the thread hands us to someone else — the
 * Person introduced a colleague, copied them in, or named their address as
 * the right contact — the message is for that new point of contact: To the
 * new contact, with the Person who referred us in Cc, so they see the
 * hand-off happen. The thread stays the Person's record; the new contact's
 * replies on it are attached to it (src/lib/outreach/replyBridge.ts).
 *
 * The draft writer names the new contact (`addressTo`); this decides whether
 * to believe it. An address is used only if it appears in the conversation
 * the model was shown — in a message's text or its from/to/cc — so a model
 * cannot invent or reconstruct one. When the model names nobody, a follow-up
 * goes to whoever our last message went to, and anything else to the Person.
 *
 * Pure and client-safe.
 */
import { isValidEmail, normalizeEmail } from "@/lib/email/recipients";
import type { MessageParticipants } from "./ai/types";

export type DraftRecipients = {
  /** Null = the Person. */
  toEmail: string | null;
  /** Null when nobody is copied. */
  ccEmails: string[] | null;
};

export const PERSON_RECIPIENTS: DraftRecipients = { toEmail: null, ccEmails: null };

type ConversationMessage = {
  direction: "inbound" | "outbound";
  bodyText: string;
  participants?: MessageParticipants;
};

/** Every address the conversation shows: in from/to/cc and in message text. */
export function addressesInConversation(conversation: readonly ConversationMessage[]): Set<string> {
  const found = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (!value) return;
    const email = normalizeEmail(value);
    if (isValidEmail(email)) found.add(email);
  };
  for (const message of conversation) {
    add(message.participants?.from);
    message.participants?.to.forEach(add);
    message.participants?.cc.forEach(add);
    for (const match of message.bodyText.matchAll(/[^\s@<>(),;:"'[\]]+@[^\s@<>(),;:"'[\]]+\.[A-Za-z]{2,}/g)) add(match[0]);
  }
  return found;
}

/**
 * Who the thread itself points at when the draft writer named nobody: a
 * follow-up goes where our last message went (a hand-off a person already
 * approved by sending it). A reply has no such default — a sender who is not
 * the Person may be the Person writing from another address, so only the
 * draft writer, reading the message, decides that.
 */
function threadDefault(
  stepType: "reply" | "follow_up",
  conversation: readonly ConversationMessage[],
): string | null {
  if (stepType !== "follow_up") return null;
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index]!;
    if (message.direction === "outbound" && message.participants) return message.participants.to[0] ?? null;
  }
  return null;
}

export function resolveDraftRecipients(input: {
  /** The draft writer's choice; null or absent = it named nobody. */
  addressTo: string | null | undefined;
  personEmail: string | null;
  /** The sending mailbox. */
  mailbox: string | null;
  stepType: "reply" | "follow_up";
  /** What the draft writer was shown, oldest first. */
  conversation: readonly ConversationMessage[];
}): DraftRecipients {
  const person = input.personEmail ? normalizeEmail(input.personEmail) : null;
  const mailbox = input.mailbox ? normalizeEmail(input.mailbox) : null;
  if (!person) return PERSON_RECIPIENTS;
  const shown = addressesInConversation(input.conversation);
  const usable = (value: string | null | undefined): string | null => {
    if (!value) return null;
    const email = normalizeEmail(value);
    if (!isValidEmail(email) || email === mailbox) return null;
    if (email === person) return email;
    return shown.has(email) ? email : null;
  };
  const named = input.addressTo === undefined || input.addressTo === null ? null : usable(input.addressTo);
  // A named address the conversation does not show is ignored, not obeyed;
  // the thread's default applies as if the writer had named nobody.
  const to = named ?? usable(threadDefault(input.stepType, input.conversation)) ?? person;
  if (to === person) return PERSON_RECIPIENTS;
  return { toEmail: to, ccEmails: [person] };
}

/** The To and Cc a draft shows and sends with. */
export function draftRecipientView(
  draft: { toEmail?: string | null; ccEmails?: readonly string[] | null },
  personEmail: string | null,
): { to: string | null; cc: string[]; redirected: boolean } {
  const to = draft.toEmail?.trim() || personEmail?.trim() || null;
  return {
    to,
    cc: [...(draft.ccEmails ?? [])],
    redirected: Boolean(draft.toEmail && personEmail && normalizeEmail(draft.toEmail) !== normalizeEmail(personEmail)),
  };
}
