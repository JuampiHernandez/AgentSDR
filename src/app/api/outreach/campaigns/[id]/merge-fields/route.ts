import { NextRequest, NextResponse } from "next/server";
import { getCampaignMergeFields } from "@/lib/outreach/campaigns";
import { withOrgContext, authContextErrorResponse } from "@/lib/auth/context";

// GET /api/outreach/campaigns/[id]/merge-fields
// { fields: [{ token, label, missing }], totalLeads }
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await withOrgContext(_req, async () => {
      const { id } = await params;
      return NextResponse.json(await getCampaignMergeFields(id));
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
