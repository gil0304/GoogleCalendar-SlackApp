const colorNameMap = new Map<string, string>([
  ['lavender', '1'],
  ['ラベンダー', '1'],
  ['sage', '2'],
  ['セージ', '2'],
  ['grape', '3'],
  ['ブドウ', '3'],
  ['flamingo', '4'],
  ['フラミンゴ', '4'],
  ['banana', '5'],
  ['バナナ', '5'],
  ['tangerine', '6'],
  ['ミカン', '6'],
  ['オレンジ', '6'],
  ['peacock', '7'],
  ['ピーコック', '7'],
  ['graphite', '8'],
  ['グラファイト', '8'],
  ['blueberry', '9'],
  ['ブルーベリー', '9'],
  ['basil', '10'],
  ['バジル', '10'],
  ['tomato', '11'],
  ['トマト', '11']
]);

export const colorOptions = [
  { label: 'ラベンダー', value: '1' },
  { label: 'セージ', value: '2' },
  { label: 'ブドウ', value: '3' },
  { label: 'フラミンゴ', value: '4' },
  { label: 'バナナ', value: '5' },
  { label: 'ミカン', value: '6' },
  { label: 'ピーコック', value: '7' },
  { label: 'グラファイト', value: '8' },
  { label: 'ブルーベリー', value: '9' },
  { label: 'バジル', value: '10' },
  { label: 'トマト', value: '11' }
];

function normalizeColorName(input: string) {
  return input.trim().toLowerCase();
}

export function resolveColorId(input?: string): string | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    if (num >= 1 && num <= 11) return String(num);
  }
  const mapped = colorNameMap.get(normalizeColorName(trimmed)) ?? colorNameMap.get(trimmed);
  return mapped ?? undefined;
}

export function colorNameFromId(colorId?: string): string | undefined {
  if (!colorId) return undefined;
  const found = colorOptions.find((opt) => opt.value === colorId);
  return found?.label;
}

export function describeColors(): string {
  const rows = [
    '色指定の例: color=ミカン / color=トマト / color=バジル',
    '対応色:'
  ];
  const seen = new Set<string>();
  for (const [name, id] of colorNameMap.entries()) {
    if (seen.has(name)) continue;
    if (/^[a-z]/.test(name)) continue;
    rows.push(`- ${name} (id:${id})`);
    seen.add(name);
  }
  rows.push('数字指定も可: 1-11');
  return rows.join('\n');
}
