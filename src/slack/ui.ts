import { colorNameFromId, colorOptions } from '../config/colors';

export type GcalFormMode = 'create' | 'free' | 'request' | 'list';
export type GcalRequestMode = 'fixed' | 'auto';

export type GcalFormData = {
  mode: GcalFormMode;
  requestMode: GcalRequestMode;
  title?: string;
  date?: string;
  time?: string;
  duration?: string;
  dateRange?: string;
  timeRange?: string;
  attendees?: string[];
  colorId?: string;
};

export type PreviewPayload =
  | {
      kind: 'create';
      title: string;
      startISO: string;
      durationMinutes: number;
      colorId?: string;
      requesterId: string;
    }
  | {
      kind: 'free';
      availabilityText: string;
      attendeeIds: string[];
      requesterId: string;
      durationMinutes: number;
      slotOptions: Array<{ label: string; value: string }>;
    }
  | {
      kind: 'request';
      title: string;
      startISO: string;
      durationMinutes: number;
      colorId?: string;
      requesterId: string;
      attendeeIds: string[];
    };

function getStateValue(state: Record<string, Record<string, any>>, blockId: string, actionId: string) {
  return state[blockId]?.[actionId];
}

export function parseFormState(state: Record<string, Record<string, any>>) {
  const errors: Record<string, string> = {};
  const mode = (getStateValue(state, 'mode_block', 'mode_select')?.selected_option?.value ?? 'create') as GcalFormMode;
  const requestMode = (getStateValue(state, 'request_mode_block', 'request_mode_select')?.selected_option
    ?.value ?? 'fixed') as GcalRequestMode;

  const title = getStateValue(state, 'title_block', 'title_input')?.value?.trim();
  const date = getStateValue(state, 'date_block', 'date_input')?.value?.trim();
  const time = getStateValue(state, 'time_block', 'time_input')?.value?.trim();
  const duration = getStateValue(state, 'duration_block', 'duration_input')?.value?.trim();
  const dateRange = getStateValue(state, 'date_range_block', 'date_range_input')?.value?.trim();
  const timeRange = getStateValue(state, 'time_range_block', 'time_range_input')?.value?.trim();
  const attendeesSelect = getStateValue(state, 'attendees_block', 'attendees_select');
  const attendees =
    attendeesSelect?.selected_users ??
    (attendeesSelect?.selected_options ?? []).map((opt: any) => opt.value) ??
    [];
  const colorId = getStateValue(state, 'color_block', 'color_select')?.selected_option?.value;

  if (mode === 'create') {
    if (!title) errors.title_block = 'タイトルは必須です。';
    if (!date) errors.date_block = '日付は必須です。';
    if (!time) errors.time_block = '時間は必須です。';
    if (!duration) errors.duration_block = '時間長は必須です。';
  }

  if (mode === 'free') {
    if (!dateRange) errors.date_range_block = '日付範囲は必須です。';
    if (!timeRange) errors.time_range_block = '時間範囲は必須です。';
    if (!duration) errors.duration_block = '時間長は必須です。';
    if (!attendees || attendees.length === 0) errors.attendees_block = '参照ユーザーを選択してください。';
  }

  if (mode === 'request') {
    if (!title) errors.title_block = 'タイトルは必須です。';
    if (!duration) errors.duration_block = '時間長は必須です。';
    if (!attendees || attendees.length === 0) errors.attendees_block = '参加者を選択してください。';
    if (requestMode === 'fixed') {
      if (!date) errors.date_block = '日付は必須です。';
      if (!time) errors.time_block = '時間は必須です。';
    } else {
      if (!dateRange) errors.date_range_block = '日付範囲は必須です。';
      if (!timeRange) errors.time_range_block = '時間範囲は必須です。';
    }
  }

  return {
    data: {
      mode,
      requestMode,
      title,
      date,
      time,
      duration,
      dateRange,
      timeRange,
      attendees,
      colorId
    } as GcalFormData,
    errors
  };
}

export function buildFormView(
  userId: string,
  teamId: string,
  baseUrl: string,
  data: Partial<GcalFormData> = {},
  connection?: { connected: boolean; email?: string },
  attendeeOptions?: Array<{ text: { type: 'plain_text'; text: string }; value: string }>,
  viewId?: string
) {
  const connectUrl = `${baseUrl}/oauth/start?team=${encodeURIComponent(teamId)}&user=${encodeURIComponent(
    userId
  )}${viewId ? `&view=${encodeURIComponent(viewId)}` : ''}`;
  const mode: GcalFormMode = data.mode ?? 'create';
  const requestMode: GcalRequestMode = data.requestMode ?? 'fixed';
  const blocks: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*モードを選んで必要な項目だけ入力してください。*'
      }
    },
    {
      type: 'actions',
      elements: connection?.connected
        ? [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Google再連携' },
              url: connectUrl
            },
            {
              type: 'button',
              action_id: 'gcal_disconnect',
              text: { type: 'plain_text', text: '連携解除' },
              style: 'danger',
              value: 'disconnect'
            }
          ]
        : [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Google連携' },
              url: connectUrl
            }
          ]
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: connection?.connected
          ? `:white_check_mark: *連携済み*${connection.email ? ` (${connection.email})` : ''}`
          : ':warning: *未連携*'
      }
    },
    {
      type: 'input',
      block_id: 'mode_block',
      dispatch_action: true,
      label: { type: 'plain_text', text: 'モード' },
      element: {
        type: 'static_select',
        action_id: 'mode_select',
        initial_option: {
          text: { type: 'plain_text', text: mode === 'create' ? '予定作成' : mode === 'free' ? '空き時間' : mode === 'request' ? '予定リクエスト' : '予定一覧' },
          value: mode
        },
        options: [
          { text: { type: 'plain_text', text: '予定作成' }, value: 'create' },
          { text: { type: 'plain_text', text: '空き時間' }, value: 'free' },
          { text: { type: 'plain_text', text: '予定リクエスト' }, value: 'request' },
          { text: { type: 'plain_text', text: '予定一覧' }, value: 'list' }
        ]
      }
    }
  ];

  if (mode === 'request') {
    blocks.push({
      type: 'input',
      block_id: 'request_mode_block',
      dispatch_action: true,
      optional: true,
      label: { type: 'plain_text', text: 'リクエスト方法' },
      element: {
        type: 'static_select',
        action_id: 'request_mode_select',
        initial_option: {
          text: { type: 'plain_text', text: requestMode === 'auto' ? '期間から自動' : '固定時間' },
          value: requestMode
        },
        options: [
          { text: { type: 'plain_text', text: '固定時間' }, value: 'fixed' },
          { text: { type: 'plain_text', text: '期間から自動' }, value: 'auto' }
        ]
      }
    });
  }

  if (mode === 'create' || mode === 'request') {
    blocks.push({
      type: 'input',
      block_id: 'title_block',
      optional: false,
      label: { type: 'plain_text', text: 'タイトル' },
      element: {
        type: 'plain_text_input',
        action_id: 'title_input',
        initial_value: data.title ?? '',
        placeholder: { type: 'plain_text', text: '例: 田中と打合せ' }
      }
    });
  }

  if (mode === 'create' || (mode === 'request' && requestMode === 'fixed')) {
    blocks.push({
      type: 'input',
      block_id: 'date_block',
      optional: false,
      label: { type: 'plain_text', text: '日付 (固定)' },
      element: {
        type: 'plain_text_input',
        action_id: 'date_input',
        initial_value: data.date ?? '',
        placeholder: { type: 'plain_text', text: '例: 3/1 または 2026-03-01' }
      }
    });
    blocks.push({
      type: 'input',
      block_id: 'time_block',
      optional: false,
      label: { type: 'plain_text', text: '時間 (固定)' },
      element: {
        type: 'plain_text_input',
        action_id: 'time_input',
        initial_value: data.time ?? '',
        placeholder: { type: 'plain_text', text: '例: 13:00' }
      }
    });
  }

  if (mode === 'free' || (mode === 'request' && requestMode === 'auto') || mode === 'list') {
    blocks.push({
      type: 'input',
      block_id: 'date_range_block',
      optional: mode === 'list',
      label: { type: 'plain_text', text: '日付範囲 (期間)' },
      element: {
        type: 'plain_text_input',
        action_id: 'date_range_input',
        initial_value: data.dateRange ?? '',
        placeholder: { type: 'plain_text', text: '例: 3/1-3/5' }
      }
    });
  }

  if (mode === 'free' || (mode === 'request' && requestMode === 'auto')) {
    blocks.push({
      type: 'input',
      block_id: 'time_range_block',
      optional: false,
      label: { type: 'plain_text', text: '時間範囲 (期間)' },
      element: {
        type: 'plain_text_input',
        action_id: 'time_range_input',
        initial_value: data.timeRange ?? '',
        placeholder: { type: 'plain_text', text: '例: 09:00-18:00' }
      }
    });
  }

  if (mode === 'create' || mode === 'free' || mode === 'request') {
    blocks.push({
      type: 'input',
      block_id: 'duration_block',
      optional: false,
      label: { type: 'plain_text', text: '時間長 (分 or 30m)' },
      element: {
        type: 'plain_text_input',
        action_id: 'duration_input',
        initial_value: data.duration ?? '',
        placeholder: { type: 'plain_text', text: '例: 30m or 60' }
      }
    });
  }

  if (mode === 'free' || mode === 'request') {
    blocks.push({
      type: 'input',
      block_id: 'attendees_block',
      optional: false,
      label: { type: 'plain_text', text: '参加者 (空き時間/招待)' },
      element: {
        type: 'multi_static_select',
        action_id: 'attendees_select',
        placeholder: { type: 'plain_text', text: '参加者を選択' },
        options: attendeeOptions ?? [],
        initial_options: (data.attendees ?? []).map((id) => ({
          text: { type: 'plain_text', text: id },
          value: id
        }))
      }
    });
  }

  if (mode === 'create' || mode === 'request') {
    blocks.push({
      type: 'input',
      block_id: 'color_block',
      optional: true,
      label: { type: 'plain_text', text: '色' },
      element: {
        type: 'static_select',
        action_id: 'color_select',
        placeholder: { type: 'plain_text', text: '任意' },
        initial_option: data.colorId
          ? {
              text: { type: 'plain_text', text: colorNameFromId(data.colorId) ?? '色' },
              value: data.colorId
            }
          : undefined,
        options: colorOptions.map((opt) => ({
          text: { type: 'plain_text', text: opt.label },
          value: opt.value
        }))
      }
    });
  }

  return {
    type: 'modal',
    callback_id: 'gcal_form',
    title: { type: 'plain_text', text: 'GCal' },
    submit: { type: 'plain_text', text: 'プレビュー' },
    close: { type: 'plain_text', text: '閉じる' },
    blocks
  };
}

export function buildPreviewView(title: string, body: string, metadata?: PreviewPayload) {
  const blocks: any[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${title}*` }
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: body }
    }
  ];

  if (metadata) {
    const elements: any[] = [];
    if (metadata.kind === 'free') {
      elements.push({
        type: 'button',
        action_id: 'gcal_share_open',
        text: { type: 'plain_text', text: '共有する' },
        style: 'primary',
        value: 'share'
      });
    } else {
      elements.push({
        type: 'button',
        action_id: 'gcal_preview_create',
        text: { type: 'plain_text', text: '作成/送信' },
        style: 'primary',
        value: 'confirm'
      });
    }
    elements.push({
      type: 'button',
      action_id: 'gcal_preview_close',
      text: { type: 'plain_text', text: '閉じる' },
      value: 'close'
    });
    blocks.push({
      type: 'actions',
      elements
    });
  } else {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'gcal_preview_close',
          text: { type: 'plain_text', text: '閉じる' },
          value: 'close'
        }
      ]
    });
  }

  const view: any = {
    type: 'modal',
    title: { type: 'plain_text', text: 'GCal' },
    close: { type: 'plain_text', text: '閉じる' },
    blocks
  };

  if (metadata) {
    view.private_metadata = JSON.stringify(metadata);
  }

  return view;
}

export function buildResultView(title: string, body: string) {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'GCal' },
    close: { type: 'plain_text', text: '閉じる' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${title}*` }
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: body }
      }
    ]
  };
}

export function buildLoadingView(title: string, body: string) {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'GCal' },
    close: { type: 'plain_text', text: '閉じる' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${title}*` }
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: body }
      }
    ]
  };
}

export function buildShareView(
  availabilityText: string,
  attendeeIds: string[] = [],
  durationMinutes?: number,
  slotOptions?: Array<{ label: string; value: string }>,
  requesterId?: string
) {
  const mentions = attendeeIds.map((id) => `<@${id}>`).join(' ');
  const attendeeLine = mentions ? `参加者：${mentions}` : '';
  const metadata = JSON.stringify({
    availabilityText,
    attendeeLine,
    durationMinutes,
    slotOptions,
    attendeeIds,
    requesterId
  });
  return {
    type: 'modal',
    callback_id: 'gcal_share',
    title: { type: 'plain_text', text: '共有' },
    submit: { type: 'plain_text', text: '送信' },
    close: { type: 'plain_text', text: 'キャンセル' },
    private_metadata: metadata,
    blocks: [
      {
        type: 'input',
        block_id: 'share_channel_block',
        label: { type: 'plain_text', text: '共有チャンネル' },
        element: {
          type: 'conversations_select',
          action_id: 'share_channel_select',
          placeholder: { type: 'plain_text', text: '共有先チャンネルを選択' }
        }
      },
      {
        type: 'input',
        block_id: 'share_message_block',
        optional: true,
        label: { type: 'plain_text', text: '追加メッセージ (任意 / リッチ入力)' },
        element: {
          type: 'rich_text_input',
          action_id: 'share_message_input',
          placeholder: { type: 'plain_text', text: '太字・箇条書き・絵文字などを使えます' }
        }
      },
      {
        type: 'input',
        block_id: 'request_title_block',
        optional: true,
        label: { type: 'plain_text', text: 'リクエストタイトル (任意)' },
        element: {
          type: 'plain_text_input',
          action_id: 'request_title_input',
          initial_value: '予定リクエスト',
          placeholder: { type: 'plain_text', text: '例: 30分MTG' }
        }
      }
    ]
  };
}
