import { createClient } from '@supabase/supabase-js';

type TokenRow = {
  team_id: string;
  user_id: string;
  refresh_token: string;
  email?: string | null;
};

type TokenStoreValue = { refreshToken: string; email?: string };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const TOKEN_TABLE = process.env.GCAL_TOKEN_TABLE || 'gcal_tokens';

if (!SUPABASE_URL) {
  throw new Error('Missing env: SUPABASE_URL');
}
if (!SUPABASE_KEY) {
  throw new Error('Missing env: SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

export async function getUserToken(
  teamId: string,
  userId: string
): Promise<TokenStoreValue | null> {
  const { data, error } = await supabase
    .from(TOKEN_TABLE)
    .select('refresh_token,email')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) return null;
  return {
    refreshToken: data.refresh_token,
    email: data.email ?? undefined
  };
}

export async function setUserToken(
  teamId: string,
  userId: string,
  refreshToken: string,
  email?: string
) {
  const { error } = await supabase.from(TOKEN_TABLE).upsert(
    {
      team_id: teamId,
      user_id: userId,
      refresh_token: refreshToken,
      email: email ?? null,
      updated_at: new Date().toISOString()
    },
    { onConflict: 'team_id,user_id' }
  );
  if (error) {
    throw error;
  }
}

export async function updateUserEmail(teamId: string, userId: string, email: string) {
  const { error } = await supabase
    .from(TOKEN_TABLE)
    .update({ email, updated_at: new Date().toISOString() })
    .eq('team_id', teamId)
    .eq('user_id', userId);
  if (error) {
    throw error;
  }
}

export async function removeUserToken(teamId: string, userId: string) {
  const { error } = await supabase
    .from(TOKEN_TABLE)
    .delete()
    .eq('team_id', teamId)
    .eq('user_id', userId);
  if (error) {
    throw error;
  }
}

export async function listUserTokens(
  teamId: string
): Promise<Array<{ userId: string; email?: string }>> {
  const { data, error } = await supabase
    .from(TOKEN_TABLE)
    .select('user_id,email')
    .eq('team_id', teamId);
  if (error) {
    throw error;
  }
  return (data ?? []).map((row: Pick<TokenRow, 'user_id' | 'email'>) => ({
    userId: row.user_id,
    email: row.email ?? undefined
  }));
}
