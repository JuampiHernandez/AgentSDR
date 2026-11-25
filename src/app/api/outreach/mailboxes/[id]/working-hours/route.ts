import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { mailboxes } from "@/lib/outreach/schema";
import type { WorkingHours } from "@/lib/outreach/schema";
import { inOrg } from "@/lib/tenancy/scope";
import { workingHoursError } from "@/lib/outreach/sendWindow";
import { withOrgContext, authContextErrorResponse } from "@/lib/auth/context";

// PATCH /api/outreach/mailboxes/[id]/working-hours — { workingHours: WorkingHours }
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await withOrgContext(req, async () => {
      const { id } = await params;
      let body: { workingHours?: WorkingHours };
      try {
        body = await req.json();
      } catch {
        return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (!body.workingHours) {
        return NextResponse.json({ error: "workingHours is required" }, { status: 400 });
      }
      // No overnight windows: a day that ends at or before it starts would send nothing (issue #18).
      const invalid = workingHoursError(body.workingHours);
      if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
      await db.update(mailboxes).set({ workingHours: body.workingHours, updatedAt: new Date() }).where(and(inOrg(mailboxes), eq(mailboxes.id, id)));
      return NextResponse.json({ ok: true });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
