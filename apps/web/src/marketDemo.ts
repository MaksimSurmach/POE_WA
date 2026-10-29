import type {
  MarketWorkbenchResponse,
  MarketTarget,
  MarketResearchSnapshotSummary,
} from '@poe-worksmith/contracts';

/** Deliberately synthetic examples. Never written to the API or represented as market evidence. */
const definitions = [
  {
    name: 'Сапоги: скорость, жизнь, сопротивления',
    slot: 'Boots',
    baseTypes: ['Two-Toned Boots'],
    builds: ['Пример: универсальный life-билд'],
    requiredMods: [
      '30% increased Movement Speed',
      '+80 to maximum Life',
      '+70% total Elemental Resistances',
    ],
    minItemLevel: 84,
  },
  {
    name: 'Пояс с жизнью и силой',
    slot: 'Belt',
    baseTypes: ['Stygian Vise'],
    builds: ['Пример: билд с требованиями к Strength'],
    requiredMods: [
      '+90 to maximum Life',
      '+45 to Strength',
      'Свободный суффикс',
    ],
    minItemLevel: 84,
  },
  {
    name: 'Кольцо под атрибуты',
    slot: 'Ring',
    baseTypes: ['Amethyst Ring'],
    builds: ['Пример: добор атрибутов'],
    requiredMods: ['+45 to Dexterity', '+60 to maximum Life'],
    minItemLevel: 82,
  },
];

const targets: MarketTarget[] = definitions.map((definition, index) => ({
  ...definition,
  id: `10000000-0000-4000-8000-00000000000${index + 1}`,
  game: 'poe1',
  realm: 'pc',
  league: 'Пример лиги',
  patch: 'demo',
  version: 1,
  digest: String(index + 1).repeat(64),
  createdAt: '2026-01-10T10:00:00Z',
  sources: [
    {
      title: 'Учебный профиль — источник билда ещё не выбран',
      url: 'https://pathofbuilding.community/',
      kind: 'manual',
    },
  ],
}));

const snapshots: MarketResearchSnapshotSummary[] = targets.flatMap(
  (target, targetIndex) => {
    if (targetIndex === 2) return [];
    return [0, 1, 2, 3, 4].map((day) => {
      const median =
        (targetIndex === 0
          ? [2.4, 2.7, 2.6, 3.1, 3.4]
          : [5.1, 4.8, 4.5, 4.3, 4.2])[day] ?? 1;
      return {
        id: `20000000-0000-4000-8000-0000000000${targetIndex}${day}`,
        targetId: target.id,
        targetVersion: 1,
        targetDigest: target.digest,
        digest: `${targetIndex}${day}`.repeat(32),
        game: 'poe1',
        realm: 'pc',
        league: target.league,
        patch: 'demo',
        capturedAt: `2026-01-${10 + day}T12:00:00Z`,
        retrievedAt: `2026-01-${10 + day}T12:05:00Z`,
        sourceUrl: 'https://www.pathofexile.com/trade',
        notes: 'Синтетические числа для проверки интерфейса.',
        provenance: 'manual_import',
        comparability: 'user_selected',
        currency: 'divine',
        dataKind: 'demo',
        outcome: 'observed',
        count: targetIndex === 0 ? 12 : 3,
        rejectedCount: 0,
        p25: median * 0.8,
        median,
        p75: median * 1.2,
      };
    });
  },
);

export const marketDemo: MarketWorkbenchResponse['data'] = {
  storage: 'unavailable',
  targets,
  snapshots,
  sources: [
    {
      id: 'manual',
      name: 'Наблюдения рынка',
      status: 'available',
      description:
        'Импорт выбранных предложений с ценой, датой и источником. В примере числа синтетические.',
      documentationUrl: 'https://www.pathofexile.com/trade',
    },
    {
      id: 'ninja',
      name: 'poe.ninja Economy',
      status: 'planned',
      description:
        'Публичные оценки валют, баз и расходников. Это отдельные данные от цены готового rare-предмета.',
      documentationUrl: 'https://poe.ninja/docs/api',
    },
    {
      id: 'stash',
      name: 'GGG Public Stash',
      status: 'requires_approval',
      description:
        'Нужен уже одобренный OAuth-клиент с service:psapi. Новые регистрации приостановлены.',
      documentationUrl: 'https://www.pathofexile.com/developer/docs',
    },
    {
      id: 'builds',
      name: 'Библиотека билдов',
      status: 'manual_only',
      description:
        'Ссылки на гайды и собственные экспорты PoB. Автоматический доступ к API билдов poe.ninja не предоставляется.',
      documentationUrl: 'https://poe.ninja/docs/api',
    },
  ],
};
