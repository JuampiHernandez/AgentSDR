import { NextRequest, NextResponse } from "next/server";
import { getMailbox, retestMailbox, deleteMailbox, updateMailboxSettings } from "@/lib/outreach/mailboxes";
import { parseMailboxSettings } from "@/lib/outreach/mailboxSettings";
import { withOrgContext, authContextErrorResponse } from "@/lib/auth/context";

// GET /api/outreach/mailboxes/[id]
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await withOrgContext(_req, async () => {
      const { id } = await params;
      const mailbox = await getMailbox(id);
      if (!mailbox) return NextResponse.json({ error: "not found" }, { status: 404 });
      return NextResponse.json({ mailbox });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

// POST /api/outreach/mailboxes/[id] — re-test the connection.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await withOrgContext(_req, async () => {
      const { id } = await params;
      const result = await retestMailbox(id);
      if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
      return NextResponse.json(result);
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

// PATCH /api/outreach/mailboxes/[id]: { displayName?: string | null, dailySendLimit?: number }
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await withOrgContext(req, async () => {
      const { id } = await params;
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const parsed = parseMailboxSettings(body);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
      if (!(await updateMailboxSettings(id, parsed.update))) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      return NextResponse.json({ ok: true });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

// DELETE /api/outreach/mailboxes/[id]
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await withOrgContext(_req, async () => {
      const { id } = await params;
      await deleteMailbox(id);
      return NextResponse.json({ ok: true });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
