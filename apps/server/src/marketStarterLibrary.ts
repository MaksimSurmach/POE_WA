import type { MarketTargetInput } from '@poe-worksmith/contracts';

const checked =
  'Проверено 2026-10-29; источник описывает билд и экипировку для 3.29, но не измеряет спрос или цену. Перепроверьте после выхода 3.30.';

function profile(
  name: string,
  build: string,
  slot: string,
  baseTypes: string[],
  requiredMods: string[],
  source: { title: string; url: string; notes: string },
): MarketTargetInput {
  return {
    name,
    game: 'poe1',
    realm: 'pc',
    league: 'Allflame',
    patch: '3.29',
    slot,
    baseTypes,
    builds: [build],
    requiredMods,
    sources: [
      { ...source, kind: 'guide', notes: `${source.notes} ${checked}` },
    ],
  };
}

const sources = {
  rf: {
    title: 'Pohx Righteous Fire Chieftain (3.29)',
    url: 'https://mobalytics.gg/poe/builds/pohx-righteous-fire-chieftain',
    notes:
      'Гайд обновлён 2026-08-07; рекомендует редкий шлем под псевдо 6-link Fire Trap.',
  },
  winterOrb: {
    title: 'Winter Orb Occultist gear',
    url: 'https://www.poe-vault.com/guides/winter-orb-occultist-gear-flasks',
    notes:
      'Гайд Winter Orb Occultist для 3.29 опубликован 2026-07-29; страница экипировки описывает ES/сопротивления и модификаторы перчаток.',
  },
  srs: {
    title: 'BalorMage Summon Raging Spirits gear',
    url: 'https://www.poe-vault.com/guides/balormage-summon-raging-spirits-necromancer-gear-jewels-flasks',
    notes:
      'Гайд для 3.29 опубликован 2026-07-26; описывает шлем с уровнями камней приспешников и жезл для приспешников.',
  },
  toxicRain: {
    title: 'Toxic Rain Pathfinder gear',
    url: 'https://www.poe-vault.com/guides/toxic-rain-pathfinder-gear-flasks',
    notes:
      'Гайд для 3.29 опубликован 2026-09-17; перечисляет модификаторы лука и колчана для Toxic Rain.',
  },
  explosiveArrow: {
    title: 'Explosive Arrow Ballista Hierophant (3.29)',
    url: 'https://www.poe-vault.com/guides/explosive-arrow-ballista-hierophant-build-guide',
    notes:
      'Гайд для 3.29 опубликован 2026-08-16; рекомендует Quill Rain и амулет с уровнями камней огня либо Replica Dragonfang.',
  },
} satisfies Record<string, { title: string; url: string; notes: string }>;

export const marketStarterLibrary: MarketTargetInput[] = [
  profile(
    'RF Chieftain — шлем Fire Trap',
    'Pohx RF Chieftain',
    'Шлем',
    ['Elder-influenced helmet'],
    ['Псевдо 6-link для Fire Trap'],
    sources.rf,
  ),
  profile(
    'RF Chieftain — Cloak of Flame',
    'Pohx RF Chieftain',
    'Нагрудник',
    ['Cloak of Flame'],
    ['Уникальный предмет, рекомендованный гайдом'],
    sources.rf,
  ),
  profile(
    'Winter Orb — нагрудник ES',
    'Winter Orb Occultist',
    'Нагрудник',
    ['Twilight Regalia'],
    ['Высокий энергетический щит', 'Сопротивления'],
    sources.winterOrb,
  ),
  profile(
    'Winter Orb — перчатки',
    'Winter Orb Occultist',
    'Перчатки',
    ['Warlock Gloves'],
    [
      'Exposure к холоду или Unnerve',
      'Сопротивления',
      'Жизнь или энергетический щит',
    ],
    sources.winterOrb,
  ),
  profile(
    'Poison SRS — шлем приспешников',
    'Poison SRS Necromancer',
    'Шлем',
    ['Helmet'],
    [
      '+1–2 к уровню камней приспешников',
      'Жизнь',
      'Сопротивления',
      'Характеристики',
    ],
    sources.srs,
  ),
  profile(
    'Poison SRS — жезл приспешников',
    'Poison SRS Necromancer',
    'Жезл',
    ['Convoking Wand'],
    [
      'Уровни камней приспешников',
      'Урон приспешников',
      'Скорость атаки или сотворения чар',
    ],
    sources.srs,
  ),
  profile(
    'Toxic Rain — лук',
    'Toxic Rain Pathfinder',
    'Лук',
    ['Thicket Bow'],
    [
      '+1 к уровню вставленных камней',
      '+2 к уровню камней поддержки',
      'Урон хаосом со временем',
      'Скорость атаки',
      'Множитель урона хаосом со временем',
    ],
    sources.toxicRain,
  ),
  profile(
    'Toxic Rain — колчан',
    'Toxic Rain Pathfinder',
    'Колчан',
    ['Broadhead Arrow Quiver'],
    [
      'Множитель урона атак со временем',
      'Скорость атаки',
      'Урон от атак луком',
      'Жизнь',
    ],
    sources.toxicRain,
  ),
  profile(
    'Explosive Arrow — Quill Rain',
    'Explosive Arrow Ballista Hierophant',
    'Лук',
    ['Quill Rain'],
    [
      'Почти 100% скорости снарядов; для Foulborn также около 100% скорости атаки',
    ],
    sources.explosiveArrow,
  ),
  profile(
    'Explosive Arrow — амулет',
    'Explosive Arrow Ballista Hierophant',
    'Амулет',
    ['Amulet', 'Replica Dragonfang’s Flight'],
    ['+1 к камням огня или +3 к Explosive Arrow'],
    sources.explosiveArrow,
  ),
];
