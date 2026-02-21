import { google } from 'googleapis';
import { requireEnv } from '../config/env';

export const oauthScopes = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email'
];

export function createOAuth2Client(baseUrl: string) {
  const clientId = requireEnv('GCAL_CLIENT_ID');
  const clientSecret = requireEnv('GCAL_CLIENT_SECRET');
  const redirectUri = process.env.GCAL_REDIRECT_URI || `${baseUrl}/oauth/callback`;

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function getCalendarClient(baseUrl: string, refreshToken: string) {
  const oauth2 = createOAuth2Client(baseUrl);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: 'v3', auth: oauth2 });
}

export async function fetchUserEmail(baseUrl: string, refreshToken: string): Promise<string | null> {
  const oauth2 = createOAuth2Client(baseUrl);
  oauth2.setCredentials({ refresh_token: refreshToken });

  const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 });
  const response = await oauth2Api.userinfo.get();
  return response.data.email ?? null;
}
