import { createClient } from '@supabase/supabase-js';
import type { Installation, InstallationQuery, InstallationStore } from '@slack/bolt';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const INSTALL_TABLE = process.env.SLACK_INSTALL_TABLE || 'slack_installations';

if (!SUPABASE_URL) {
  throw new Error('Missing env: SUPABASE_URL');
}
if (!SUPABASE_KEY) {
  throw new Error('Missing env: SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

type InstallationRow = {
  team_id: string | null;
  enterprise_id: string | null;
  installation: Installation;
};

function resolveQueryKey(query: InstallationQuery<boolean>) {
  const enterpriseId = query.enterpriseId ?? null;
  const teamId = query.teamId ?? null;
  return { enterpriseId, teamId, isEnterpriseInstall: query.isEnterpriseInstall ?? false };
}

export const slackInstallationStore: InstallationStore = {
  async storeInstallation(installation: Installation) {
    const enterpriseId = installation.enterprise?.id ?? null;
    const teamId = installation.team?.id ?? null;
    const isEnterpriseInstall = installation.isEnterpriseInstall ?? false;

    if (!enterpriseId && !teamId) {
      throw new Error('Missing enterprise/team ID on installation');
    }

    const { error } = await supabase.from(INSTALL_TABLE).upsert(
      {
        enterprise_id: enterpriseId,
        team_id: teamId,
        installation,
        updated_at: new Date().toISOString()
      },
      { onConflict: isEnterpriseInstall ? 'enterprise_id' : 'team_id' }
    );
    if (error) {
      throw error;
    }
  },

  async fetchInstallation(query: InstallationQuery<boolean>) {
    const { enterpriseId, teamId, isEnterpriseInstall } = resolveQueryKey(query);
    if (!enterpriseId && !teamId) {
      throw new Error('Missing enterprise/team ID on installation query');
    }

    const builder = supabase.from(INSTALL_TABLE).select('installation').limit(1);
    const { data, error } = isEnterpriseInstall
      ? await builder.eq('enterprise_id', enterpriseId)
      : await builder.eq('team_id', teamId);

    if (error) {
      throw error;
    }

    const row = (data?.[0] as InstallationRow | undefined) ?? undefined;
    if (!row?.installation) {
      throw new Error('No installation found');
    }

    return row.installation;
  },

  async deleteInstallation(query: InstallationQuery<boolean>) {
    const { enterpriseId, teamId, isEnterpriseInstall } = resolveQueryKey(query);
    if (!enterpriseId && !teamId) {
      throw new Error('Missing enterprise/team ID on installation query');
    }
    const builder = supabase.from(INSTALL_TABLE).delete();
    const { error } = isEnterpriseInstall
      ? await builder.eq('enterprise_id', enterpriseId)
      : await builder.eq('team_id', teamId);
    if (error) {
      throw error;
    }
  }
};
