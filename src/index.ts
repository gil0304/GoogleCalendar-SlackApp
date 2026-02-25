import 'dotenv/config';
import { App, ExpressReceiver } from '@slack/bolt';
import crypto from 'node:crypto';
import { DateTime } from 'luxon';

import { requireEnv } from './config/env';
import { resolveColorId } from './config/colors';
import { createOAuth2Client, fetchUserEmail, getCalendarClient, oauthScopes } from './google/oauth';
import { getUserToken, listUserTokens, removeUserToken, setUserToken, updateUserEmail } from './store/tokenStore';
import { slackInstallationStore } from './store/slackInstallationStore';
import {
  formatTimeRange,
  isValidTimeRange,
  parseDate,
  parseDateRange,
  parseDuration,
  parseTime,
  parseTimeRange
} from './utils/parse';
import {
  buildFreeIntervals,
  findFirstAvailableSlot,
  formatIntervalsShort,
  listDays,
  mergeBusyIntervals,
  parseBusyInterval
} from './utils/intervals';
import {
  buildFormView,
  buildPreviewView,
  buildLoadingView,
  buildResultView,
  buildShareView,
  parseFormState,
  GcalFormMode,
  GcalRequestMode,
  PreviewPayload
} from './slack/ui';

const sharedRequestMap = new Map<
  string,
  {
    teamId: string;
    requesterId: string;
    attendeeIds: string[];
    title: string;
    durationMinutes: number;
    slotOptions: Array<{ label: string; value: string }>;
    baseBlocks: any[];
    eventId?: string;
    selectedLabel?: string;
  }
>();

async function buildAttendeeOptions(client: any, teamId: string, currentUserId: string) {
  const users = await listUserTokens(teamId);
  const results: Array<{ text: { type: 'plain_text'; text: string }; value: string }> = [];
  for (const item of users) {
    if (results.length >= 100) break;
    let label = item.email ?? item.userId;
    try {
      const info = await client.users.info({ user: item.userId });
      if (info.ok && info.user) {
        const profile: any = info.user.profile ?? {};
        label = profile.display_name || profile.real_name || item.email || item.userId;
      }
    } catch {
      // ignore if scope missing
    }
    if (item.userId === currentUserId) {
      label = `${label} (自分)`;
    }
    results.push({ text: { type: 'plain_text', text: label }, value: item.userId });
  }
  return results;
}

function resolveTeamId(payload: any, context?: any) {
  return (
    context?.teamId ||
    payload?.team?.id ||
    payload?.team_id ||
    payload?.user?.team_id ||
    payload?.user?.teamId ||
    ''
  );
}

function buildShareMessageBlocks(
  baseBlocks: any[],
  slotOptions: Array<{ label: string; value: string }>,
  selectedLabel?: string
) {
  const blocks = [...baseBlocks];
  blocks.push({ type: 'divider' });
  if (selectedLabel) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `送信済み: *${selectedLabel}*` }
    });
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'gcal_share_retry',
          text: { type: 'plain_text', text: '再リクエスト' },
          style: 'danger',
          value: 'retry'
        }
      ]
    });
  } else {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '予約リクエストを送る時間を選択してください' },
      accessory: {
        type: 'static_select',
        action_id: 'gcal_share_request_select',
        placeholder: { type: 'plain_text', text: '候補時間を選択' },
        options: slotOptions.map((opt) => ({
          text: { type: 'plain_text', text: opt.label },
          value: opt.value
        }))
      }
    });
  }
  return blocks;
}

async function main() {
  const signingSecret = requireEnv('SLACK_SIGNING_SECRET');
  const botToken = process.env.SLACK_BOT_TOKEN;
  const port = Number(process.env.PORT || 3000);
  const baseUrl = process.env.APP_BASE_URL || `http://localhost:${port}`;

  const receiverOptions: any = { signingSecret };
  if (!botToken) {
    receiverOptions.clientId = requireEnv('SLACK_CLIENT_ID');
    receiverOptions.clientSecret = requireEnv('SLACK_CLIENT_SECRET');
    receiverOptions.stateSecret = requireEnv('SLACK_STATE_SECRET');
    receiverOptions.scopes = ['commands', 'chat:write', 'users:read', 'im:write'];
    receiverOptions.installationStore = slackInstallationStore;
    receiverOptions.installerOptions = {
      installPath: '/slack/install',
      redirectUriPath: '/slack/oauth_redirect'
    };
  }

  const receiver = new ExpressReceiver(receiverOptions);
  receiver.app.get('/health', (_req, res) => res.status(200).send('ok'));

  const appOptions: any = { receiver };
  if (botToken) {
    appOptions.token = botToken;
  }

  const app = new App(appOptions);

  const oauthState = new Map<
    string,
    { userId: string; teamId: string; createdAt: number; viewId?: string }
  >();

  receiver.app.get('/oauth/start', (req, res) => {
    const userId = typeof req.query.user === 'string' ? req.query.user : '';
    const teamId = typeof req.query.team === 'string' ? req.query.team : '';
    const viewId = typeof req.query.view === 'string' ? req.query.view : '';
    if (!userId || !teamId) {
      res.status(400).send('Missing user.');
      return;
    }

    const state = crypto.randomBytes(16).toString('hex');
    oauthState.set(state, {
      userId,
      teamId,
      createdAt: Date.now(),
      viewId: viewId || undefined
    });

    const oauth2 = createOAuth2Client(baseUrl);
    const authUrl = oauth2.generateAuthUrl({
      access_type: 'offline',
      scope: oauthScopes,
      prompt: 'consent',
      include_granted_scopes: true,
      state
    });

    res.redirect(authUrl);
  });

  receiver.app.get('/oauth/callback', async (req, res) => {
    try {
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const state = typeof req.query.state === 'string' ? req.query.state : '';

      if (!code || !state) {
        res.status(400).send('Missing code/state.');
        return;
      }

      const stateInfo = oauthState.get(state);
      if (!stateInfo) {
        res.status(400).send('Invalid state.');
        return;
      }
      oauthState.delete(state);

      const oauth2 = createOAuth2Client(baseUrl);
      const { tokens } = await oauth2.getToken(code);

      if (!tokens.refresh_token) {
        const existing = await getUserToken(stateInfo.teamId, stateInfo.userId);
        if (existing?.refreshToken) {
          res.send('連携は有効です。Slackに戻って /gcal を試してください。');
          return;
        }

        res.status(400).send(
          'Refresh tokenが取得できませんでした。Googleアカウントの権限を解除して再連携してください。'
        );
        return;
      }

      let email: string | undefined;
      try {
        email = (await fetchUserEmail(baseUrl, tokens.refresh_token)) ?? undefined;
      } catch (err) {
        console.warn('Failed to fetch email', err);
      }

      await setUserToken(stateInfo.teamId, stateInfo.userId, tokens.refresh_token, email);

      if (stateInfo.viewId) {
        try {
          const attendeeOptions = await buildAttendeeOptions(
            app.client,
            stateInfo.teamId,
            stateInfo.userId
          );
          await app.client.views.update({
            view_id: stateInfo.viewId,
            view: buildFormView(
              stateInfo.userId,
              baseUrl,
              {},
              { connected: true, email },
              attendeeOptions,
              stateInfo.viewId
            ) as any
          });
        } catch (viewErr) {
          console.warn('Failed to update modal after OAuth', viewErr);
        }
      }

      res.send('Googleカレンダー連携が完了しました。Slackに戻って確認してください。');
    } catch (err) {
      console.error('OAuth callback failed', err);
      res.status(500).send('OAuth処理に失敗しました。');
    }
  });

  app.command('/gcal', async ({ command, ack, client, respond, context }: any) => {
    await ack();
    const teamId = resolveTeamId(command, context);

    let viewId: string | undefined;
    try {
      const opened = await client.views.open({
        trigger_id: command.trigger_id,
        view: buildLoadingView('読み込み中', 'フォームを準備しています...') as any
      });
      viewId = (opened as any)?.view?.id;
    } catch (err) {
      console.error('Failed to open /gcal modal', err);
      if (respond) {
        await respond({
          response_type: 'ephemeral',
          text: 'モーダルを開けませんでした。もう一度 /gcal を実行してください。'
        });
      }
      return;
    }

    try {
      const [tokenInfo, attendeeOptions] = await Promise.all([
        getUserToken(teamId, command.user_id),
        buildAttendeeOptions(client, teamId, command.user_id)
      ]);

      if (!viewId) {
        console.warn('Missing view_id after views.open for /gcal');
        return;
      }

      await client.views.update({
        view_id: viewId,
        view: buildFormView(
          command.user_id,
          baseUrl,
          {},
          { connected: !!tokenInfo?.refreshToken, email: tokenInfo?.email },
          attendeeOptions,
          viewId
        ) as any
      });
    } catch (err) {
      console.error('Failed to build /gcal form view', err);
      if (viewId) {
        await client.views.update({
          view_id: viewId,
          view: buildResultView('エラー', 'フォームの準備に失敗しました。もう一度お試しください。') as any
        });
      }
    }
  });

  app.action('mode_select', async ({ ack, body, client, context }: any) => {
    await ack();
    const teamId = resolveTeamId(body, context);
    const current = parseFormState(body.view.state.values).data;
    const selected = (body.actions[0] as any)?.selected_option?.value as GcalFormMode | undefined;
    const next = { ...current, mode: selected ?? current.mode };
    const tokenInfo = await getUserToken(teamId, body.user.id);
    const attendeeOptions = await buildAttendeeOptions(client, teamId, body.user.id);
    await client.views.update({
      view_id: body.view.id,
      view: buildFormView(
        body.user.id,
        baseUrl,
        next,
        { connected: !!tokenInfo?.refreshToken, email: tokenInfo?.email },
        attendeeOptions,
        body.view.id
      ) as any
    });
  });

  app.action('request_mode_select', async ({ ack, body, client, context }: any) => {
    await ack();
    const teamId = resolveTeamId(body, context);
    const current = parseFormState(body.view.state.values).data;
    const selected = (body.actions[0] as any)?.selected_option?.value as GcalRequestMode | undefined;
    const next = { ...current, requestMode: selected ?? current.requestMode, mode: 'request' as GcalFormMode };
    const tokenInfo = await getUserToken(teamId, body.user.id);
    const attendeeOptions = await buildAttendeeOptions(client, teamId, body.user.id);
    await client.views.update({
      view_id: body.view.id,
      view: buildFormView(
        body.user.id,
        baseUrl,
        next,
        { connected: !!tokenInfo?.refreshToken, email: tokenInfo?.email },
        attendeeOptions,
        body.view.id
      ) as any
    });
  });

  app.action('gcal_disconnect', async ({ ack, body, client, context }: any) => {
    await ack();
    const teamId = resolveTeamId(body, context);
    await removeUserToken(teamId, body.user.id);
    await client.views.update({
      view_id: body.view.id,
      view: buildFormView(body.user.id, baseUrl, { mode: 'create' }, { connected: false }, [], body.view.id) as any
    });
  });

  app.view('gcal_form', async ({ ack, body, view, client, context }: any) => {
    const zone = process.env.GCAL_TIMEZONE || 'UTC';
    const { data, errors } = parseFormState(view.state.values);
    if (Object.keys(errors).length > 0) {
      await ack({ response_action: 'errors', errors });
      return;
    }

    await ack({
      response_action: 'update',
      view: buildLoadingView('処理中', 'しばらくお待ちください...') as any
    });

    const now = DateTime.now().setZone(zone);
    const requesterId = body.user.id;
    const viewId = body.view.id;
    const teamId = resolveTeamId(body, context);
    const requesterToken = await getUserToken(teamId, requesterId);
    const connectUrl = `${baseUrl}/oauth/start?team=${encodeURIComponent(
      teamId
    )}&user=${encodeURIComponent(requesterId)}&view=${encodeURIComponent(viewId)}`;

    if (!requesterToken?.refreshToken && data.mode !== 'free') {
      await client.views.update({
        view_id: viewId,
        view: buildResultView(
          'Google連携が必要です',
          `先にGoogleアカウント連携が必要です。\n${connectUrl}`
        ) as any
      });
      return;
    }

    try {
      if (data.mode === 'create') {
        const date = parseDate(data.date!, now);
        const time = parseTime(data.time!);
        const durationMinutes = parseDuration(data.duration!);
        if (!date || !time || !durationMinutes) {
        await client.views.update({
          view_id: viewId,
          view: buildResultView('入力エラー', '日付/時間/時間長を確認してください。') as any
        });
        return;
      }
        const start = DateTime.fromObject(
          {
            year: date.year,
            month: date.month,
            day: date.day,
            hour: time.hour,
            minute: time.minute
          },
          { zone }
        );

        const colorId =
          data.colorId ?? resolveColorId(process.env.GCAL_DEFAULT_COLOR ?? undefined);

        const previewBody = [
          `タイトル: ${data.title}`,
          `開始: ${start.toFormat('yyyy-LL-dd HH:mm')} (${zone})`,
          `時間: ${durationMinutes}分`,
          colorId ? `色: ${colorId}` : '色: なし'
        ].join('\n');

        const metadata: PreviewPayload = {
          kind: 'create',
          title: data.title!,
          startISO: start.toISO()!,
          durationMinutes,
          colorId,
          requesterId
        };

        await client.views.update({
          view_id: viewId,
          view: buildPreviewView('予定作成プレビュー', previewBody, metadata) as any
        });
        return;
      }

      if (data.mode === 'free') {
        const dateRange = parseDateRange(data.dateRange!, now);
        const timeRange = parseTimeRange(data.timeRange!);
        const durationMinutes = parseDuration(data.duration!);
        if (!dateRange || !timeRange || !durationMinutes || !isValidTimeRange(timeRange)) {
        await client.views.update({
          view_id: viewId,
          view: buildResultView('入力エラー', '入力内容を確認してください。') as any
        });
        return;
      }

        const missing: string[] = [];
        const tokensByUser = new Map<string, string>();
        for (const userId of data.attendees ?? []) {
          const tokenInfo = await getUserToken(teamId, userId);
          if (!tokenInfo?.refreshToken) {
            missing.push(userId);
          } else {
            tokensByUser.set(userId, tokenInfo.refreshToken);
          }
        }

        if (missing.length > 0) {
        await client.views.update({
          view_id: viewId,
          view: buildResultView(
            '未連携ユーザーがあります',
            `以下のユーザーは未連携です: ${missing.map((id) => `<@${id}>`).join(' ')}\n各ユーザーが /gcal を実行してください。`
          ) as any
        });
        return;
      }

        const overallStart = dateRange.startDate.set({
          hour: timeRange.start.hour,
          minute: timeRange.start.minute
        });
        const overallEnd = dateRange.endDate.set({
          hour: timeRange.end.hour,
          minute: timeRange.end.minute
        });
        if (overallEnd <= overallStart) {
        await client.views.update({
          view_id: viewId,
          view: buildResultView('入力エラー', '時間範囲の指定が不正です。') as any
        });
        return;
      }

        const busyIntervals: Array<{ start: DateTime; end: DateTime }> = [];
        for (const refreshToken of tokensByUser.values()) {
          const calendar = getCalendarClient(baseUrl, refreshToken);
          const result = await calendar.freebusy.query({
            requestBody: {
              timeMin: overallStart.toISO(),
              timeMax: overallEnd.toISO(),
              timeZone: zone,
              items: [{ id: 'primary' }]
            }
          });

          const busy = result.data.calendars?.primary?.busy ?? [];
          for (const interval of busy) {
            if (!interval.start || !interval.end) continue;
            // DEBUG_FREEBUSY logs disabled
            const parsed = parseBusyInterval(interval.start, interval.end, zone);
            const start = parsed.start;
            const end = parsed.end;
            if (start.isValid && end.isValid) {
              busyIntervals.push({ start, end });
            }
          }

          // Supplement: treat all-day events as busy for the whole day
          const allDayEvents = await calendar.events.list({
            calendarId: process.env.GCAL_CALENDAR_ID || 'primary',
            timeMin: overallStart.toISO(),
            timeMax: overallEnd.toISO(),
            singleEvents: true,
            orderBy: 'startTime'
          } as any);
          const items = (allDayEvents as any)?.data?.items ?? [];
          for (const event of items) {
            const startDate = event.start?.date;
            const endDate = event.end?.date;
            if (!startDate || !endDate) continue;
            const parsed = parseBusyInterval(startDate, endDate, zone);
            if (parsed.start.isValid && parsed.end.isValid) {
              busyIntervals.push({ start: parsed.start, end: parsed.end });
            }
          }
        }

        const days = listDays(dateRange.startDate, dateRange.endDate);
        const slotOptions: Array<{ label: string; value: string }> = [];
        const dayBlocks = days.map((day) => {
          const dayLabel = day.setLocale('ja').toFormat('M/d(ccc)');
          const dayStart = day.set({
            hour: timeRange.start.hour,
            minute: timeRange.start.minute
          });
          const dayEnd = day.set({
            hour: timeRange.end.hour,
            minute: timeRange.end.minute
          });
          const mergedBusy = mergeBusyIntervals(busyIntervals, dayStart, dayEnd);
          const freeIntervals = buildFreeIntervals(dayStart, dayEnd, mergedBusy).filter((interval) => {
            return interval.end.diff(interval.start, 'minutes').minutes >= durationMinutes;
          });
          const slots = formatIntervalsShort(freeIntervals).replace(/ - /g, '〜');
          for (const interval of freeIntervals) {
            if (slotOptions.length >= 25) break;
            const label = `${dayLabel} ${interval.start.toFormat('HH:mm')}〜${interval.end.toFormat('HH:mm')}`;
            const value = `${interval.start.toISO()}|${durationMinutes}`;
            slotOptions.push({ label, value });
          }
          return `${dayLabel}\n${slots}`;
        });

        const attendeeLine = data.attendees && data.attendees.length > 0
          ? `参加者：${data.attendees.map((id) => `<@${id}>`).join(' ')}`
          : '';
        const header = `空き時間（${dateRange.startDate.toFormat('M/d')}〜${dateRange.endDate.toFormat('M/d')} ${formatTimeRange(timeRange).replace('-', '〜')}）`;
        const availabilityLines = [header, ...dayBlocks];
        const availabilityText = availabilityLines.join('\n');
        const previewLines = [attendeeLine, '```', availabilityText, '```'].filter(Boolean);
        const shareText = previewLines.join('\n');

        await client.views.update({
          view_id: viewId,
          view: buildPreviewView('空き時間結果', shareText, {
            kind: 'free',
            availabilityText,
            attendeeIds: data.attendees ?? [],
            requesterId,
            durationMinutes,
            slotOptions
          }) as any
        });
        return;
      }

      if (data.mode === 'list') {
        const calendar = getCalendarClient(baseUrl, requesterToken!.refreshToken);
        const dateRange = data.dateRange ? parseDateRange(data.dateRange, now) : null;
        const timeMin = dateRange ? dateRange.startDate.toISO() : now.toISO();
        const timeMax = dateRange ? dateRange.endDate.plus({ days: 1 }).toISO() : now.plus({ days: 7 }).toISO();

        const result = await calendar.events.list({
          calendarId: process.env.GCAL_CALENDAR_ID || 'primary',
          timeMin,
          timeMax,
          maxResults: 10,
          singleEvents: true,
          orderBy: 'startTime'
        } as any);

        const items = (result as any)?.data?.items ?? [];
        const lines = items.length === 0
          ? ['予定がありません。']
          : items.map((event: any) => {
              const startIso = event.start?.dateTime || event.start?.date || '';
              const start = startIso ? DateTime.fromISO(startIso, { zone }) : null;
              const label = start?.isValid ? start.toFormat('M/d HH:mm') : '未定';
              return `${label} ${event.summary ?? '(タイトルなし)'}`;
            });

        const header = dateRange
          ? `予定一覧（${dateRange.startDate.toFormat('M/d')}〜${dateRange.endDate.toFormat('M/d')}）`
          : '予定一覧（直近7日）';
        const listText = [header, ...lines].join('\n');
        const previewText = ['```', listText, '```'].join('\n');

        await client.views.update({
          view_id: viewId,
          view: buildPreviewView('予定一覧', previewText) as any
        });
        return;
      }

      if (data.mode === 'request') {
        const durationMinutes = parseDuration(data.duration!);
        if (!durationMinutes) {
        await client.views.update({
          view_id: viewId,
          view: buildResultView('入力エラー', '時間長を確認してください。') as any
        });
        return;
      }

        const attendeeIds = data.attendees ?? [];
        const missing: string[] = [];
        const attendeeTokens = new Map<string, string>();
        for (const userId of attendeeIds) {
          const tokenInfo = await getUserToken(teamId, userId);
          if (!tokenInfo?.refreshToken) {
            missing.push(userId);
          } else {
            attendeeTokens.set(userId, tokenInfo.refreshToken);
          }
        }

        if (missing.length > 0) {
        await client.views.update({
          view_id: viewId,
          view: buildResultView(
            '未連携ユーザーがあります',
            `以下のユーザーは未連携です: ${missing.map((id) => `<@${id}>`).join(' ')}\n各ユーザーが /gcal を実行してください。`
          ) as any
        });
        return;
      }

        let start: DateTime;
        if (data.requestMode === 'auto') {
          const dateRange = parseDateRange(data.dateRange!, now);
          const timeRange = parseTimeRange(data.timeRange!);
          if (!dateRange || !timeRange || !isValidTimeRange(timeRange)) {
            await client.views.update({
              view_id: viewId,
              view: buildResultView('入力エラー', '入力内容を確認してください。') as any
            });
            return;
          }

          const overallStart = dateRange.startDate.set({
            hour: timeRange.start.hour,
            minute: timeRange.start.minute
          });
          const overallEnd = dateRange.endDate.set({
            hour: timeRange.end.hour,
            minute: timeRange.end.minute
          });
          if (overallEnd <= overallStart) {
            await client.views.update({
              view_id: viewId,
              view: buildResultView('入力エラー', '時間範囲の指定が不正です。') as any
            });
            return;
          }

          const busyIntervals: Array<{ start: DateTime; end: DateTime }> = [];
          const busyTokens = new Map(attendeeTokens);
          busyTokens.set(requesterId, requesterToken!.refreshToken);

          for (const refreshToken of busyTokens.values()) {
            const calendar = getCalendarClient(baseUrl, refreshToken);
            const result = await calendar.freebusy.query({
              requestBody: {
                timeMin: overallStart.toISO(),
                timeMax: overallEnd.toISO(),
                timeZone: zone,
                items: [{ id: 'primary' }]
              }
            });

            const busy = result.data.calendars?.primary?.busy ?? [];
            for (const interval of busy) {
              if (!interval.start || !interval.end) continue;
              // DEBUG_FREEBUSY logs disabled
              const parsed = parseBusyInterval(interval.start, interval.end, zone);
              const startBusy = parsed.start;
              const endBusy = parsed.end;
              if (startBusy.isValid && endBusy.isValid) {
                busyIntervals.push({ start: startBusy, end: endBusy });
              }
            }
          }

          const days = listDays(dateRange.startDate, dateRange.endDate);
          const slot = findFirstAvailableSlot(days, timeRange, durationMinutes, busyIntervals);
          if (!slot) {
            await client.views.update({
              view_id: viewId,
              view: buildResultView('空きが見つかりませんでした', '指定期間内で空きが見つかりませんでした。') as any
            });
            return;
          }
          start = slot;
        } else {
          const date = parseDate(data.date!, now);
          const time = parseTime(data.time!);
          if (!date || !time) {
            await client.views.update({
              view_id: viewId,
              view: buildResultView('入力エラー', '日付/時間を確認してください。') as any
            });
            return;
          }
          start = DateTime.fromObject(
            {
              year: date.year,
              month: date.month,
              day: date.day,
              hour: time.hour,
              minute: time.minute
            },
            { zone }
          );
        }

        const colorId =
          data.colorId ?? resolveColorId(process.env.GCAL_DEFAULT_COLOR ?? undefined);

        const previewBody = [
          `タイトル: ${data.title}`,
          `開始: ${start.toFormat('yyyy-LL-dd HH:mm')} (${zone})`,
          `時間: ${durationMinutes}分`,
          `参加者: ${attendeeIds.map((id) => `<@${id}>`).join(' ')}`,
          colorId ? `色: ${colorId}` : '色: なし'
        ].join('\n');

        const metadata: PreviewPayload = {
          kind: 'request',
          title: data.title!,
          startISO: start.toISO()!,
          durationMinutes,
          colorId,
          requesterId,
          attendeeIds
        };

        await client.views.update({
          view_id: viewId,
          view: buildPreviewView('予定リクエストプレビュー', previewBody, metadata) as any
        });
        return;
      }
    } catch (err) {
      console.error('Failed to build preview', err);
      await client.views.update({
        view_id: viewId,
        view: buildResultView('エラー', '処理に失敗しました。設定や権限を確認してください。') as any
      });
    }
  });

  app.action('gcal_preview_close', async ({ ack, body, client }: any) => {
    await ack();
    await client.views.update({
      view_id: body.view.id,
      view: buildResultView('完了', 'モーダルを閉じてください。') as any
    });
  });

  app.action('gcal_share_open', async ({ ack, body, client, context }: any) => {
    await ack();
    const teamId = resolveTeamId(body, context);
    let payload: PreviewPayload | null = null;
    try {
      payload = body.view.private_metadata ? (JSON.parse(body.view.private_metadata) as PreviewPayload) : null;
    } catch {
      payload = null;
    }

    if (!payload || payload.kind !== 'free') {
      await client.views.update({
        view_id: body.view.id,
        view: buildResultView('エラー', '共有情報が取得できませんでした。') as any
      });
      return;
    }

    await client.views.push({
      trigger_id: body.trigger_id,
      view: buildShareView(
        payload.availabilityText,
        payload.attendeeIds,
        payload.durationMinutes,
        payload.slotOptions,
        payload.requesterId
      ) as any
    });
  });

  app.view('gcal_share', async ({ ack, body, view, client, context }: any) => {
    const teamId = resolveTeamId(body, context);
    const channel = view.state.values['share_channel_block']?.['share_channel_select']?.selected_conversation;
    const messageInput = view.state.values['share_message_block']?.['share_message_input'];
    const messagePlain = messageInput?.value?.trim();
    const messageRichValue =
      messageInput?.rich_text_value ?? messageInput?.rich_text ?? messageInput;
    const messageRichElements =
      messageRichValue?.elements ?? messageRichValue?.rich_text?.elements ?? null;

    if (!channel) {
      await ack({
        response_action: 'errors',
        errors: { share_channel_block: '共有先を選択してください。' }
      });
      return;
    }

    await ack({ response_action: 'clear' });

    let metadata: { availabilityText: string; attendeeLine?: string; durationMinutes?: number; slotOptions?: Array<{ label: string; value: string }>; attendeeIds?: string[]; requesterId?: string } | null = null;
    try {
      metadata = view.private_metadata
        ? (JSON.parse(view.private_metadata) as { availabilityText: string; attendeeLine?: string; durationMinutes?: number; slotOptions?: Array<{ label: string; value: string }>; attendeeIds?: string[]; requesterId?: string })
        : null;
    } catch {
      metadata = null;
    }

    const availabilityText = metadata?.availabilityText ?? '';
    const attendeeLine = metadata?.attendeeLine ?? '';
    const codeBlock = availabilityText ? ['```', availabilityText, '```'].join('\n') : '';
    const slotOptions = metadata?.slotOptions ?? [];
    const requestTitle = view.state.values['request_title_block']?.['request_title_input']?.value?.trim() || '予定リクエスト';
    const attendeeIds = metadata?.attendeeIds ?? [];
    const requesterId = metadata?.requesterId ?? body.user.id;

    const baseBlocks: any[] = [];
    if (attendeeLine) {
      baseBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: attendeeLine } });
    }
    if (messageRichElements?.length) {
      baseBlocks.push({ type: 'rich_text', elements: messageRichElements });
    } else if (messagePlain) {
      baseBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: messagePlain } });
    }
    if (codeBlock) {
      baseBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: codeBlock } });
    }

    const fallbackText = [attendeeLine, messagePlain, availabilityText].filter(Boolean).join('\n');
    const blocks = slotOptions.length > 0 ? buildShareMessageBlocks(baseBlocks, slotOptions) : baseBlocks;

    try {
      const response = await client.chat.postMessage({
        channel,
        text: fallbackText || '空き時間を共有しました。',
        blocks: blocks.length > 0 ? blocks : undefined
      });
      if (!response.ok) {
        throw new Error(response.error || 'unknown_error');
      }
      if (response.ts) {
        const key = `${teamId}:${channel}:${response.ts}`;
        sharedRequestMap.set(key, {
          teamId,
          requesterId,
          attendeeIds,
          title: requestTitle,
          durationMinutes: metadata?.durationMinutes ?? 0,
          slotOptions,
          baseBlocks
        });
      }
      // no-op: success notification is unnecessary
    } catch (err: any) {
      console.error('Failed to share free slots', err);
      try {
        await client.chat.postEphemeral({
          channel,
          user: body.user.id,
          text: `空き時間の共有に失敗しました: ${err?.message ?? 'unknown_error'}`
        });
      } catch (ephemeralErr) {
        console.warn('Failed to post ephemeral error', ephemeralErr);
      }
      try {
        const dm = await client.conversations.open({ users: body.user.id });
        if (dm.ok && dm.channel?.id) {
          await client.chat.postMessage({
            channel: dm.channel.id,
            text: `空き時間の共有に失敗しました: ${err?.message ?? 'unknown_error'}`
          });
        }
      } catch (notifyErr) {
        console.error('Failed to notify user about share error', notifyErr);
      }
    }
  });

  app.action('gcal_share_request_select', async ({ ack, body, client, context }: any) => {
    await ack();
    const teamId = resolveTeamId(body, context);
    const channelId = body.channel?.id;
    const messageTs = body.message?.ts;
    const value = (body.actions[0] as any)?.selected_option?.value as string | undefined;
    if (!channelId || !messageTs || !value) return;

    const [startIso, durationStr] = value.split('|');
    const durationMinutes = Number(durationStr);
    if (!startIso || !durationMinutes) return;

    const key = `${teamId}:${channelId}:${messageTs}`;
    const meta = sharedRequestMap.get(key);
    if (!meta) return;
    if (meta.eventId) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: 'すでに送信済みです。再リクエストを使ってください。'
      });
      return;
    }

    const requesterToken = await getUserToken(meta.teamId, meta.requesterId);
    if (!requesterToken?.refreshToken) return;

    const attendees: { email: string }[] = [];
    const missing: string[] = [];
    for (const userId of meta.attendeeIds) {
      const tokenInfo = await getUserToken(meta.teamId, userId);
      if (!tokenInfo?.refreshToken) {
        missing.push(userId);
        continue;
      }
      let email: string | undefined = tokenInfo.email;
      if (!email) {
        try {
          email = (await fetchUserEmail(baseUrl, tokenInfo.refreshToken)) ?? undefined;
          if (email) {
            await updateUserEmail(meta.teamId, userId, email);
          }
        } catch {
          missing.push(userId);
          continue;
        }
      }
      if (!email) {
        missing.push(userId);
        continue;
      }
      attendees.push({ email });
    }

    if (missing.length > 0) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: `未連携/メール取得不可: ${missing.map((id) => `<@${id}>`).join(' ')}`
      });
      return;
    }

    try {
      const calendar = getCalendarClient(baseUrl, requesterToken.refreshToken);
      const start = DateTime.fromISO(startIso, { zone: process.env.GCAL_TIMEZONE || 'UTC' });
      const end = start.plus({ minutes: durationMinutes });
      const calendarId = process.env.GCAL_CALENDAR_ID || 'primary';

      const created = await calendar.events.insert({
        calendarId,
        sendUpdates: 'all',
        requestBody: {
          summary: meta.title,
          start: { dateTime: start.toISO(), timeZone: process.env.GCAL_TIMEZONE || 'UTC' },
          end: { dateTime: end.toISO(), timeZone: process.env.GCAL_TIMEZONE || 'UTC' },
          attendees
        }
      });

      meta.eventId = created.data.id ?? undefined;
      meta.selectedLabel = body.actions[0]?.selected_option?.text?.text ?? undefined;
      sharedRequestMap.set(key, meta);

      if (meta.baseBlocks && meta.slotOptions) {
        const blocks = buildShareMessageBlocks(meta.baseBlocks, meta.slotOptions, meta.selectedLabel);
        await client.chat.update({
          channel: channelId,
          ts: messageTs,
          text: '予約リクエストを送信しました。',
          blocks
        });
      }

      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: `予約リクエストを送信しました: ${start.toFormat('M/d HH:mm')}`
      });
    } catch (err) {
      console.error('Failed to create request from shared slots', err);
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: '予約リクエストの送信に失敗しました。'
      });
    }
  });

  app.action('gcal_share_retry', async ({ ack, body, client, context }: any) => {
    await ack();
    const teamId = resolveTeamId(body, context);
    const channelId = body.channel?.id;
    const messageTs = body.message?.ts;
    if (!channelId || !messageTs) return;

    const key = `${teamId}:${channelId}:${messageTs}`;
    const meta = sharedRequestMap.get(key);
    if (!meta) return;

    if (!meta.eventId) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: '再リクエストできる予定が見つかりませんでした。'
      });
      return;
    }

    try {
      const requesterToken = await getUserToken(meta.teamId, meta.requesterId);
      if (!requesterToken?.refreshToken) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: body.user.id,
          text: 'リクエスト作成者が未連携です。'
        });
        return;
      }

      const calendar = getCalendarClient(baseUrl, requesterToken.refreshToken);
      await calendar.events.delete({
        calendarId: process.env.GCAL_CALENDAR_ID || 'primary',
        eventId: meta.eventId,
        sendUpdates: 'all'
      });

      meta.eventId = undefined;
      meta.selectedLabel = undefined;
      sharedRequestMap.set(key, meta);

      const blocks = buildShareMessageBlocks(meta.baseBlocks, meta.slotOptions);
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: '再リクエストが可能になりました。',
        blocks
      });
    } catch (err) {
      console.error('Failed to retry request', err);
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: '再リクエストに失敗しました。'
      });
    }
  });

  app.action('gcal_preview_create', async ({ ack, body, client, context }: any) => {
    await ack();
    const zone = process.env.GCAL_TIMEZONE || 'UTC';
    const teamId = resolveTeamId(body, context);
    let payload: PreviewPayload | null = null;
    try {
      payload = body.view.private_metadata ? (JSON.parse(body.view.private_metadata) as PreviewPayload) : null;
    } catch {
      payload = null;
    }

    if (!payload) {
      await client.views.update({
        view_id: body.view.id,
        view: buildResultView('エラー', 'プレビュー情報が取得できませんでした。') as any
      });
      return;
    }

    try {
      const requesterToken = await getUserToken(teamId, payload.requesterId);
      if (!requesterToken?.refreshToken) {
        const connectUrl = `${baseUrl}/oauth/start?team=${encodeURIComponent(
          teamId
        )}&user=${encodeURIComponent(payload.requesterId)}&view=${encodeURIComponent(body.view.id)}`;
        await client.views.update({
          view_id: body.view.id,
          view: buildResultView('Google連携が必要です', `先にGoogleアカウント連携が必要です。\n${connectUrl}`) as any
        });
        return;
      }

      if (payload.kind !== 'create' && payload.kind !== 'request') {
        await client.views.update({
          view_id: body.view.id,
          view: buildResultView('エラー', 'この操作はサポートされていません。') as any
        });
        return;
      }

      const calendar = getCalendarClient(baseUrl, requesterToken.refreshToken);
      const start = DateTime.fromISO(payload.startISO, { zone });
      const end = start.plus({ minutes: payload.durationMinutes });
      const calendarId = process.env.GCAL_CALENDAR_ID || 'primary';

      if (payload.kind === 'create') {
        const result = await calendar.events.insert({
          calendarId,
          requestBody: {
            summary: payload.title,
            start: { dateTime: start.toISO(), timeZone: zone },
            end: { dateTime: end.toISO(), timeZone: zone },
            colorId: payload.colorId
          }
        });
        const link = result.data.htmlLink ? `\n${result.data.htmlLink}` : '';
        await client.views.update({
          view_id: body.view.id,
          view: buildResultView(
            '予定を作成しました',
            `開始: ${start.toFormat('yyyy-LL-dd HH:mm')} (${zone})${link}`
          ) as any
        });
        return;
      }

      if (payload.kind === 'request') {
        const attendees: { email: string }[] = [];
        const missing: string[] = [];
        for (const userId of payload.attendeeIds) {
          const tokenInfo = await getUserToken(teamId, userId);
          if (!tokenInfo?.refreshToken) {
            missing.push(userId);
            continue;
          }
          let email = tokenInfo.email;
          if (!email) {
            try {
              email = (await fetchUserEmail(baseUrl, tokenInfo.refreshToken)) ?? undefined;
              if (email) {
                await updateUserEmail(teamId, userId, email);
              }
            } catch (err) {
              console.warn('Failed to fetch email for attendee', err);
            }
          }
          if (!email) {
            missing.push(userId);
            continue;
          }
          attendees.push({ email });
        }

        if (missing.length > 0) {
        await client.views.update({
          view_id: body.view.id,
          view: buildResultView(
            '未連携ユーザーがあります',
            `以下のユーザーは未連携/メール取得不可です: ${missing
              .map((id) => `<@${id}>`)
              .join(' ')}\n各ユーザーが /gcal を実行してください。`
          ) as any
        });
        return;
      }

        const result = await calendar.events.insert({
          calendarId,
          sendUpdates: 'all',
          requestBody: {
            summary: payload.title,
            start: { dateTime: start.toISO(), timeZone: zone },
            end: { dateTime: end.toISO(), timeZone: zone },
            attendees,
            colorId: payload.colorId
          }
        });
        const link = result.data.htmlLink ? `\n${result.data.htmlLink}` : '';
        await client.views.update({
          view_id: body.view.id,
          view: buildResultView(
            '予定リクエストを送信しました',
            `開始: ${start.toFormat('yyyy-LL-dd HH:mm')} (${zone})${link}`
          ) as any
        });
        return;
      }
    } catch (err) {
      console.error('Failed to create from preview', err);
      await client.views.update({
        view_id: body.view.id,
        view: buildResultView('エラー', '処理に失敗しました。設定や権限を確認してください。') as any
      });
    }
  });

  await app.start(port);
  console.log(`Slack Bolt app is running on port ${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
