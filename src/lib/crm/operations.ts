import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { isPersonDoNotContact } from "./policies";
import { followUpDateError } from "./followUpDate";
import { followUpNoteError } from "./followUpNote";
import { appendCrmEvent } from "./events";
import {
  acknowledgeClassificationInTransaction,
  findClassificationInOrg,
  lockCrmRecord,
  setRecordClassificationInTransaction,
  type CrmRecord,
  transitionWorkflowInTransaction,
} from "./records";
import { CrmConflictError, CrmNotFoundError, type CrmTransaction, withCrmTransaction } from "./repository";
import {
  crmConversationMessages,
  crmConversations,
  crmClassifications,
  crmDrafts,
  crmJobs,
  crmRecords,
  crmSendAttempts,
  crmSequenceRuns,
  type CrmCategoryKey,
} from "./schema";
import { inboundAnsweredFromCrm } from "./manualOutbound";
import {
  interruptActiveSequenceRunInTransaction,
  startFollowUpsInTransaction,
  startSequenceRunInTransaction,
} from "./sequences";
import { stageChangeRoute } from "./stageChange";
import { STAGE_MOVED_EVENT, type StageMoveNext } from "./stageMove";
import { inOrg } from "@/lib/tenancy/scope";

export type ApplyHumanClassificationInput = {
  recordId: string;
  categoryKey: CrmCategoryKey;
  subcategoryId: string | null;
  expectedContextVersion: number;
  classificationId?: string;
  reason?: string | null;
  actorRef?: string | null;
  /**
   * The picker's "What next?". "follow_up" drafts no reply: the stage's
   * follow-ups are scheduled instead. Omitted or "reply": a reply is drafted
   * unless the rep already answered from AgentSDR.
   */
  next?: StageMoveNext;
  /**
   * What happened. Recorded as a `stage.moved` event (in place of
   * `classification.changed`) because that event is what drafts read.
   */
  note?: string | null;
};

export function applyHumanClassification(input: ApplyHumanClassificationInput) {
  return withCrmTransaction((tx) => applyHumanClassificationInTransaction(tx, input));
}

export async function applyHumanClassificationInTransaction(tx: CrmTransaction, input: ApplyHumanClassificationInput) {
  const before = await lockCrmRecord(tx, input.recordId);
  if (!before.latestInboundMessageId) {
    throw new CrmConflictError("CRM record has no inbound message to classify");
  }
  let classificationId = input.classificationId;
  if (!classificationId) {
    const [existing] = await tx.select().from(crmClassifications).where(and(
      eq(crmClassifications.crmRecordId, before.id),
      eq(crmClassifications.messageId, before.latestInboundMessageId),
      eq(crmClassifications.expectedContextVersion, input.expectedContextVersion),
    )).limit(1).for("update");
    if (existing) {
      const [classification] = await tx.update(crmClassifications).set({
        proposedCategoryKey: input.categoryKey,
        proposedSubcategoryId: input.subcategoryId,
        appliedCategoryKey: input.categoryKey,
        appliedSubcategoryId: input.subcategoryId,
        confidence: existing.confidence ?? "1",
        reasoning: input.reason?.trim() || existing.reasoning || "Classified by an authenticated operator",
        status: "accepted",
        error: null,
        acknowledgedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(crmClassifications.id, existing.id)).returning();
      classificationId = classification!.id;
    } else {
      const [classification] = await tx.insert(crmClassifications).values({
        crmRecordId: before.id,
        messageId: before.latestInboundMessageId,
        expectedContextVersion: input.expectedContextVersion,
        previousCategoryKey: before.categoryKey,
        previousSubcategoryId: before.subcategoryId,
        proposedCategoryKey: input.categoryKey,
        proposedSubcategoryId: input.subcategoryId,
        appliedCategoryKey: input.categoryKey,
        appliedSubcategoryId: input.subcategoryId,
        confidence: "1",
        reasoning: input.reason?.trim() || "Classified by an authenticated operator",
        status: "accepted",
        acknowledgedAt: new Date(),
      }).returning();
      if (!classification) throw new Error("Human classification insert did not return a row");
      classificationId = classification.id;
    }
  }
  const note = input.note?.trim() || null;
  const updated = await setRecordClassificationInTransaction(tx, {
    recordId: input.recordId,
    categoryKey: input.categoryKey,
    subcategoryId: input.subcategoryId,
    expectedContextVersion: input.expectedContextVersion,
    reason: input.reason,
    actorRef: input.actorRef,
    classificationId,
    source: "human",
    actorType: "authenticated_operator",
    ...(note ? { eventType: STAGE_MOVED_EVENT, eventMeta: { occurredAt: new Date().toISOString(), note, next: input.next ?? "reply" } } : {}),
  });
  // Confirmed after the rep already replied from AgentSDR: that reply was
  // the immediate one, so the confirmed stage continues with its
  // follow-ups instead of drafting a second reply.
  const repliedFromCrm = await inboundAnsweredFromCrm(tx, before.id, before.latestInboundMessageId);
  // A re-applied classification keeps its id, and its draft job has
  // usually already succeeded for the previous run's step.
  return restartRecordWorkInTransaction(tx, updated, {
    draftJob: repliedFromCrm || input.next === "follow_up" ? null : { entityId: classificationId, requeueCompleted: true },
    actorRef: input.actorRef,
  });
}

/**
 * After a person sets a record's subcategory: retire the drafts written for
 * the old context, start the new subcategory's sequence, and queue its first
 * draft. Shared by a correction and a stage move — they differ in what they
 * record about the AI's classification, not in what happens next.
 *
 * With `draftJob: null` the reply step is skipped instead: the run starts at
 * its first follow-up, nothing is drafted now, and the record waits for that
 * follow-up to come due.
 */
async function restartRecordWorkInTransaction(
  tx: CrmTransaction,
  updated: CrmRecord,
  input: {
    draftJob: { entityId: string; requeueCompleted: boolean } | null;
    actorRef?: string | null;
  },
) {
  // The context just moved on, so every open draft — including hand-written
  // ones, which no sequence run owns — was written for a reply brief that no
  // longer applies. Inbound replies do the same; without it the old draft
  // stays "awaiting review" and fails with a stale-context error on send.
  await tx.update(crmDrafts).set({ status: "stale", updatedAt: new Date() }).where(and(
    eq(crmDrafts.crmRecordId, updated.id),
    inArray(crmDrafts.status, ["generating", "awaiting_review", "failed"]),
    ne(crmDrafts.expectedContextVersion, updated.contextVersion),
  ));
  if (!updated.latestInboundMessageId || await isPersonDoNotContact(tx, updated.personId)) {
    return { record: updated, sequenceRun: null };
  }
  const [conversation] = await tx.select({ id: crmConversations.id })
    .from(crmConversationMessages)
    .innerJoin(crmConversations, eq(crmConversations.id, crmConversationMessages.conversationId))
    .where(and(
      eq(crmConversationMessages.id, updated.latestInboundMessageId),
      eq(crmConversations.crmRecordId, updated.id),
    )).limit(1);
  if (!conversation) throw new CrmConflictError("Latest inbound conversation was not found");
  const runInput = {
    recordId: updated.id,
    conversationId: conversation.id,
    triggerMessageId: updated.latestInboundMessageId,
    expectedContextVersion: updated.contextVersion,
    actorType: "authenticated_operator" as const,
    actorRef: input.actorRef,
  };
  // Nothing is on anyone's desk until the first follow-up comes due; with
  // no follow-ups there is nothing left to do at this stage.
  if (!input.draftJob) return startFollowUpsInTransaction(tx, runInput);
  const started = await startSequenceRunInTransaction(tx, runInput);
  // Same rule as the AI path: a classified reply always gets a draft. When
  // no sequence covers the subcategory the draft comes from the thread.
  const { enqueueCrmJobInTransaction } = await import("./queue");
  const payload = started?.stepRuns[0]
    ? { stepRunId: started.stepRuns[0].id }
    : { recordId: updated.id };
  const { job, created } = await enqueueCrmJobInTransaction(tx, {
    kind: "initial_draft",
    entityId: input.draftJob.entityId,
    payload,
    requeueCompleted: input.draftJob.requeueCompleted,
  });
  // A job still queued from the previous change points at a step run that
  // was just cancelled; aim it at the new one instead.
  if (!created && job.status === "queued") {
    await tx.update(crmJobs).set({ payload, updatedAt: new Date() }).where(and(inOrg(crmJobs), eq(crmJobs.id, job.id), eq(crmJobs.status, "queued")));
  }
  return { record: updated, sequenceRun: started };
}

export type MoveRecordStageInput = {
  recordId: string;
  categoryKey: CrmCategoryKey;
  subcategoryId: string | null;
  expectedContextVersion: number;
  /** When it happened; defaults to now. */
  occurredAt?: Date | null;
  note?: string | null;
  /**
   * What happens next. "follow_up" — the usual case — takes the new stage's
   * immediate reply as already handled and schedules its follow-ups;
   * "reply" drafts that reply now.
   */
  next: StageMoveNext;
  actorRef?: string | null;
  /**
   * Who moved it: a person (the default), or an integration acting on what
   * happened elsewhere — a Cal.com booking (src/lib/crm/meetings.ts).
   */
  source?: "human" | "integration";
};

/**
 * Move a record to another stage because something happened outside the
 * thread — a meeting took place, a trial started. Unlike a correction, the
 * AI's reading of the latest reply was right and stays accepted; what changed
 * is where the deal is. The new stage's sequence starts as it would for a
 * correction, and its drafts are told what happened (see loadDraftSubject).
 */
export function moveRecordStage(input: MoveRecordStageInput) {
  return withCrmTransaction((tx) => moveRecordStageInTransaction(tx, input));
}

export async function moveRecordStageInTransaction(tx: CrmTransaction, input: MoveRecordStageInput) {
  const before = await lockCrmRecord(tx, input.recordId);
  if (!before.latestInboundMessageId) {
    throw new CrmConflictError("CRM record has no inbound message to continue from");
  }
  if (before.categoryKey === input.categoryKey && before.subcategoryId === input.subcategoryId) {
    throw new CrmConflictError("The record is already at this stage");
  }
  const occurredAt = input.occurredAt ?? new Date();
  if (occurredAt.getTime() > Date.now() + 60_000) {
    throw new CrmConflictError("A stage move cannot happen in the future");
  }
  const note = input.note?.trim() || null;
  // The draft job is keyed to a classification (a trigger enforces it), so it
  // hangs off the AI's reading of the latest reply — the row this move leaves
  // as it was. Read before anything is written, so a refusal changes nothing.
  const [classification] = await tx.select({ id: crmClassifications.id }).from(crmClassifications).where(and(
    eq(crmClassifications.crmRecordId, before.id),
    eq(crmClassifications.messageId, before.latestInboundMessageId),
  )).orderBy(desc(crmClassifications.createdAt)).limit(1);
  if (!classification) throw new CrmConflictError("Classify the latest reply before moving this record's stage");
  const integration = input.source === "integration";
  const updated = await setRecordClassificationInTransaction(tx, {
    recordId: input.recordId,
    categoryKey: input.categoryKey,
    subcategoryId: input.subcategoryId,
    expectedContextVersion: input.expectedContextVersion,
    source: integration ? "integration" : "human",
    actorType: integration ? "integration" : "authenticated_operator",
    actorRef: input.actorRef,
    eventType: STAGE_MOVED_EVENT,
    eventMeta: { occurredAt: occurredAt.toISOString(), note, next: input.next },
  });
  return restartRecordWorkInTransaction(tx, updated, {
    draftJob: input.next === "reply" ? { entityId: classification.id, requeueCompleted: true } : null,
    actorRef: input.actorRef,
  });
}

export type ChangeRecordStageInput = {
  recordId: string;
  categoryKey: CrmCategoryKey;
  subcategoryId: string | null;
  expectedContextVersion: number;
  next: StageMoveNext;
  note?: string | null;
  classificationId?: string;
  actorRef?: string | null;
};

/**
 * The classification picker's one entry point. While the AI is asking for a
 * review of the latest reply (none, proposed or failed) the pick corrects
 * that reading; otherwise the reading was right and the pick moves the stage.
 * See `stageChangeRoute`.
 */
export function changeRecordStage(input: ChangeRecordStageInput) {
  return withCrmTransaction(async (tx) => {
    const record = await lockCrmRecord(tx, input.recordId);
    const [latest] = record.latestInboundMessageId
      ? await tx.select({ status: crmClassifications.status }).from(crmClassifications).where(and(
        eq(crmClassifications.crmRecordId, record.id),
        eq(crmClassifications.messageId, record.latestInboundMessageId),
      )).orderBy(desc(crmClassifications.createdAt)).limit(1)
      : [];
    if (stageChangeRoute(latest?.status ?? null) === "correction") {
      return applyHumanClassificationInTransaction(tx, input);
    }
    return moveRecordStageInTransaction(tx, {
      recordId: input.recordId,
      categoryKey: input.categoryKey,
      subcategoryId: input.subcategoryId,
      expectedContextVersion: input.expectedContextVersion,
      note: input.note,
      next: input.next,
      occurredAt: null,
      actorRef: input.actorRef,
    });
  });
}

export async function acknowledgeClassification(input: {
  classificationId: string;
  actorRef?: string | null;
}) {
  return withCrmTransaction((tx) => acknowledgeClassificationInTransaction(tx, {
    classificationId: input.classificationId,
    actorType: "authenticated_operator",
    actorRef: input.actorRef,
  }));
}

export async function undoClassification(input: {
  classificationId: string;
  actorRef?: string | null;
}) {
  return withCrmTransaction(async (tx) => {
    const candidate = await findClassificationInOrg(tx, input.classificationId);
    if (!candidate) throw new CrmNotFoundError("CRM classification", input.classificationId);
    const record = await lockCrmRecord(tx, candidate.crmRecordId);
    const [classification] = await tx.select().from(crmClassifications)
      .where(eq(crmClassifications.id, candidate.id)).limit(1).for("update");
    if (!classification) throw new CrmNotFoundError("CRM classification", input.classificationId);
    if (classification.messageId !== record.latestInboundMessageId) {
      throw new CrmConflictError("Only the latest inbound classification can be undone");
    }
    if (!classification.appliedCategoryKey || classification.status === "rejected") {
      throw new CrmConflictError("This classification has no applied change to undo");
    }
    await interruptActiveSequenceRunInTransaction(tx, {
      recordId: record.id,
      reason: "classification_undone",
      contextVersion: record.contextVersion,
    });
    const now = new Date();
    const nextContextVersion = record.contextVersion + 1;
    const [updated] = await tx.update(crmRecords).set({
      categoryKey: classification.previousCategoryKey,
      subcategoryId: classification.previousSubcategoryId,
      categorySource: classification.previousCategoryKey ? "human" : null,
      categoryLocked: classification.previousCategoryKey === "customer",
      workflowState: "action_required",
      nextActionAt: null,
      contextVersion: nextContextVersion,
      updatedAt: now,
    }).where(eq(crmRecords.id, record.id)).returning();
    await tx.update(crmClassifications).set({
      status: "rejected",
      acknowledgedAt: now,
      updatedAt: now,
    }).where(eq(crmClassifications.id, classification.id));
    await appendCrmEvent(tx, {
      personId: record.personId,
      crmRecordId: record.id,
      pipelineId: record.pipelineId,
      eventType: "classification.undone",
      actorType: "authenticated_operator",
      actorRef: input.actorRef,
      fromData: { categoryKey: record.categoryKey, subcategoryId: record.subcategoryId },
      toData: {
        categoryKey: classification.previousCategoryKey,
        subcategoryId: classification.previousSubcategoryId,
        classificationId: classification.id,
      },
      contextVersion: nextContextVersion,
    });
    return updated!;
  });
}

export async function assignSequenceToRecord(input: {
  recordId: string;
  sequenceId: string;
  conversationId: string;
  expectedContextVersion: number;
  startStepPosition?: number;
  actorRef?: string | null;
}) {
  return withCrmTransaction(async (tx) => {
    const record = await lockCrmRecord(tx, input.recordId);
    if (!record.latestInboundMessageId) throw new CrmConflictError("CRM record has no inbound message");
    const started = await startSequenceRunInTransaction(tx, {
      ...input,
      triggerMessageId: record.latestInboundMessageId,
      actorType: "authenticated_operator",
    });
    if (!started) throw new CrmConflictError("CRM record requires a subcategory before assigning a sequence");
    return started;
  });
}

export async function closeCrmRecord(input: {
  recordId: string;
  reason: string;
  actorRef?: string | null;
}) {
  return withCrmTransaction(async (tx) => {
    const record = await lockCrmRecord(tx, input.recordId);
    await interruptActiveSequenceRunInTransaction(tx, {
      recordId: record.id,
      reason: "record_closed",
      contextVersion: record.contextVersion,
    });
    await tx.update(crmSequenceRuns).set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(crmSequenceRuns.crmRecordId, record.id), eq(crmSequenceRuns.status, "interrupted")));
    return transitionWorkflowInTransaction(tx, {
      recordId: record.id,
      to: "closed",
      actorType: "authenticated_operator",
      actorRef: input.actorRef,
      reason: "human_close",
      closedReason: input.reason,
    });
  });
}

/**
 * "Follow up on a date": the lead said "contact me in 45 days". Nothing goes
 * out now, the sequence stops, and the record leaves the queue ('waiting' with
 * a future next_action_at) until that day, when it returns to Action required
 * as a "Due follow-up". A new reply from them before then is handled as usual
 * (inbound ingest reclassifies and reopens the record).
 */
export async function scheduleFollowUpOn(input: {
  recordId: string;
  at: Date;
  /** Why it is later and what to do on the day; shown to the team and used to draft the follow-up. */
  note: string;
  actorRef?: string | null;
}) {
  const dateError = followUpDateError(input.at);
  if (dateError) throw new CrmConflictError(dateError);
  const note = input.note.trim();
  const noteError = followUpNoteError(note);
  if (noteError) throw new CrmConflictError(noteError);
  return withCrmTransaction(async (tx) => {
    const record = await lockCrmRecord(tx, input.recordId);
    if (record.workflowState === "closed") throw new CrmConflictError("Reopen the lead first");
    if (await isPersonDoNotContact(tx, record.personId)) throw new CrmConflictError("This Person is globally marked Do Not Contact");
    // A follow-up date is a person's decision, so it applies from any open
    // state (error and idle included), not only the moves the workflow makes
    // by itself. The version bump below makes anything in flight stale.
    const now = new Date();
    // A send nobody could confirm would keep the lead in Action required as a
    // problem. Deciding to follow up later is moving on from it: it is set
    // aside, its outcome recorded as unknown, never resent.
    const uncertain = await tx.select({ id: crmDrafts.id }).from(crmDrafts)
      .where(and(eq(crmDrafts.crmRecordId, record.id), eq(crmDrafts.status, "delivery_uncertain")));
    const setAside = uncertain.map((draft) => draft.id);
    if (setAside.length) {
      await tx.update(crmSendAttempts).set({
        status: "reconciled",
        reconciledAt: now,
        reconciliationNote: `Delivery unknown; set aside when a follow-up was scheduled for ${input.at.toISOString().slice(0, 10)}`,
        updatedAt: now,
      }).where(and(inArray(crmSendAttempts.draftId, setAside), eq(crmSendAttempts.status, "delivery_uncertain")));
      await tx.update(crmDrafts).set({ status: "discarded", autoSendAt: null, updatedAt: now })
        .where(inArray(crmDrafts.id, setAside));
    }
    await interruptActiveSequenceRunInTransaction(tx, {
      recordId: record.id,
      reason: "follow_up_scheduled",
      contextVersion: record.contextVersion,
    });
    await tx.update(crmSequenceRuns).set({ status: "cancelled", updatedAt: now })
      .where(and(eq(crmSequenceRuns.crmRecordId, record.id), eq(crmSequenceRuns.status, "interrupted")));
    // Nothing may go out before the date, auto-send included. (The version
    // bump below already makes any of them stale; discarding is explicit.)
    await tx.update(crmDrafts).set({ status: "discarded", autoSendAt: null, updatedAt: now })
      .where(and(eq(crmDrafts.crmRecordId, record.id), inArray(crmDrafts.status, ["generating", "awaiting_review", "failed"])));
    const nextContextVersion = record.contextVersion + 1;
    const [updated] = await tx.update(crmRecords)
      .set({ workflowState: "waiting", nextActionAt: input.at, contextVersion: nextContextVersion, updatedAt: now })
      .where(eq(crmRecords.id, record.id)).returning();
    await appendCrmEvent(tx, {
      personId: record.personId,
      crmRecordId: record.id,
      pipelineId: record.pipelineId,
      eventType: "record.follow_up_scheduled",
      actorType: "authenticated_operator",
      actorRef: input.actorRef,
      fromData: { workflowState: record.workflowState, nextActionAt: record.nextActionAt },
      toData: { dueAt: input.at.toISOString(), note },
      meta: setAside.length ? { uncertainDraftsSetAside: setAside } : null,
      contextVersion: nextContextVersion,
    });
    return updated!;
  });
}

export async function reopenCrmRecord(input: { recordId: string; actorRef?: string | null }) {
  return withCrmTransaction(async (tx) => {
    const record = await lockCrmRecord(tx, input.recordId);
    if (record.workflowState !== "closed") throw new CrmConflictError("Only closed CRM records can be reopened");
    return transitionWorkflowInTransaction(tx, {
      recordId: record.id,
      to: record.latestInboundMessageId ? "action_required" : "idle",
      actorType: "authenticated_operator",
      actorRef: input.actorRef,
      reason: "human_reopen",
    });
  });
}

export async function createManualDraft(input: {
  recordId: string;
  conversationId: string;
  subject?: string | null;
  bodyText: string;
  bodyHtml?: string | null;
}) {
  const bodyText = input.bodyText.trim();
  if (!bodyText) throw new Error("Draft body is required");
  return withCrmTransaction(async (tx) => {
    const record = await lockCrmRecord(tx, input.recordId);
    if (await isPersonDoNotContact(tx, record.personId)) throw new CrmConflictError("This Person is globally marked Do Not Contact");
    const [conversation] = await tx.select().from(crmConversations)
      .where(and(eq(crmConversations.id, input.conversationId), eq(crmConversations.crmRecordId, record.id))).limit(1);
    if (!conversation) throw new CrmNotFoundError("CRM conversation", input.conversationId);
    if (conversation.channel === "email" && !input.subject?.trim()) throw new Error("Email subject is required");
    const [draft] = await tx.insert(crmDrafts).values({
      crmRecordId: record.id,
      conversationId: conversation.id,
      replyForMessageId: record.latestInboundMessageId,
      expectedContextVersion: record.contextVersion,
      channel: conversation.channel,
      subject: conversation.channel === "email" ? input.subject!.trim() : null,
      editedBodyText: bodyText,
      editedBodyHtml: input.bodyHtml?.trim() || null,
      status: "awaiting_review",
    }).returning();
    if (!draft) throw new Error("Manual CRM draft insert did not return a row");
    await tx.update(crmRecords).set({ workflowState: "action_required", nextActionAt: null, updatedAt: new Date() })
      .where(eq(crmRecords.id, record.id));
    return draft;
  });
}
