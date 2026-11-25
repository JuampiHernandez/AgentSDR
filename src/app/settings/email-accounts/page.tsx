import AddMailboxButton from "@/components/outreach/AddMailboxButton";
import MailboxesPageClient from "@/components/outreach/MailboxesPageClient";
import { RequiresPlatform } from "@/components/settings/RequiresPlatform";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { requirePageOrgContext } from "@/lib/auth/context";
import { runInOrganization } from "@/lib/tenancy/scope";
import { listMailboxes } from "@/lib/outreach/mailboxes";
import { channelRules } from "@/lib/channels/rules.server";

export const dynamic = "force-dynamic";

export const metadata = { title: "Email accounts" };

async function Mailboxes() {
  const ctx = await requirePageOrgContext();
  const [mailboxes, rules] = await runInOrganization(ctx.organizationId, () => Promise.all([listMailboxes(), channelRules("email")]));
  return <MailboxesPageClient mailboxes={mailboxes} sendGapMinutes={rules.sendGapMinutes} />;
}

export default function EmailAccountsPage() {
  return (
    <SettingsPage
      title="Email accounts"
      description="The mailboxes outreach campaigns send from."
      actions={
        <RequiresPlatform platform="google" fallback={null}>
          <AddMailboxButton />
        </RequiresPlatform>
      }
    >
      <RequiresPlatform platform="google">
        <Mailboxes />
      </RequiresPlatform>
    </SettingsPage>
  );
}
