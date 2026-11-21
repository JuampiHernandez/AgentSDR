import { describe, expect, test } from "bun:test";
import { addressesInConversation, draftRecipientView, resolveDraftRecipients } from "./draftRecipients";

const person = "bob@acme.com";
const mailbox = "rep@us.com";
const ourEmail = { direction: "outbound" as const, bodyText: "Hi Bob, quick question…", participants: { from: mailbox, to: [person], cc: [] } };

describe("resolveDraftRecipients", () => {
  test("a new contact the reply names in its text: To them, Cc the person", () => {
    const conversation = [ourEmail, { direction: "inbound" as const, bodyText: "Not me — talk to Jane (Jane.Doe@acme.com), she runs ops.", participants: { from: person, to: [mailbox], cc: [] } }];
    expect(resolveDraftRecipients({ addressTo: "jane.doe@acme.com", personEmail: person, mailbox, stepType: "reply", conversation }))
      .toEqual({ toEmail: "jane.doe@acme.com", ccEmails: [person] });
  });

  test("a contact copied into the reply counts", () => {
    const conversation = [ourEmail, { direction: "inbound" as const, bodyText: "Looping in Jane who owns this.", participants: { from: person, to: [mailbox], cc: ["jane@acme.com"] } }];
    expect(resolveDraftRecipients({ addressTo: "Jane@Acme.com ", personEmail: person, mailbox, stepType: "reply", conversation }))
      .toEqual({ toEmail: "jane@acme.com", ccEmails: [person] });
  });

  test("an address the conversation never shows is ignored", () => {
    const conversation = [ourEmail, { direction: "inbound" as const, bodyText: "Talk to Jane in ops.", participants: { from: person, to: [mailbox], cc: [] } }];
    expect(resolveDraftRecipients({ addressTo: "jane@acme.com", personEmail: person, mailbox, stepType: "reply", conversation }))
      .toEqual({ toEmail: null, ccEmails: null });
  });

  test("never our own mailbox; the person themselves is the default", () => {
    expect(resolveDraftRecipients({ addressTo: mailbox, personEmail: person, mailbox, stepType: "reply", conversation: [ourEmail] }))
      .toEqual({ toEmail: null, ccEmails: null });
    expect(resolveDraftRecipients({ addressTo: "BOB@acme.com", personEmail: person, mailbox, stepType: "reply", conversation: [ourEmail] }))
      .toEqual({ toEmail: null, ccEmails: null });
  });

  test("a follow-up stays with the contact our last message went to", () => {
    const conversation = [
      ourEmail,
      { direction: "inbound" as const, bodyText: "Try jane@acme.com", participants: { from: person, to: [mailbox], cc: [] } },
      { direction: "outbound" as const, bodyText: "Hi Jane, Bob pointed me to you…", participants: { from: mailbox, to: ["jane@acme.com"], cc: [person] } },
    ];
    expect(resolveDraftRecipients({ addressTo: null, personEmail: person, mailbox, stepType: "follow_up", conversation }))
      .toEqual({ toEmail: "jane@acme.com", ccEmails: [person] });
    // The writer can still send it back to the person.
    expect(resolveDraftRecipients({ addressTo: person, personEmail: person, mailbox, stepType: "follow_up", conversation }))
      .toEqual({ toEmail: null, ccEmails: null });
  });

  test("a reply with no named contact goes to the person, even when someone else wrote", () => {
    const conversation = [ourEmail, { direction: "inbound" as const, bodyText: "Bob here from my other address.", participants: { from: "bob.personal@gmail.com", to: [mailbox], cc: [] } }];
    expect(resolveDraftRecipients({ addressTo: null, personEmail: person, mailbox, stepType: "reply", conversation }))
      .toEqual({ toEmail: null, ccEmails: null });
  });

  test("no person email: nothing to redirect from", () => {
    expect(resolveDraftRecipients({ addressTo: "jane@acme.com", personEmail: null, mailbox, stepType: "reply", conversation: [] }))
      .toEqual({ toEmail: null, ccEmails: null });
  });
});

describe("addressesInConversation", () => {
  test("reads headers and text, lower-cased", () => {
    const found = addressesInConversation([{ direction: "inbound", bodyText: "write to <Ana@X.io> or ana.b@x.io.", participants: { from: "a@b.co", to: ["c@d.co"], cc: ["e@f.co"] } }]);
    expect([...found].sort()).toEqual(["a@b.co", "ana.b@x.io", "ana@x.io", "c@d.co", "e@f.co"]);
  });
});

describe("draftRecipientView", () => {
  test("shows the person when the draft names nobody", () => {
    expect(draftRecipientView({ toEmail: null, ccEmails: null }, person)).toEqual({ to: person, cc: [], redirected: false });
  });
  test("flags a hand-off", () => {
    expect(draftRecipientView({ toEmail: "jane@acme.com", ccEmails: [person] }, person)).toEqual({ to: "jane@acme.com", cc: [person], redirected: true });
  });
});
