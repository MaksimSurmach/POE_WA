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
    'Winter Orb Elementalist — Stygian Vise (исследование)',
    'Winter Orb Elementalist',
    'Belt',
    ['Stygian Vise'],
    [
      'Максимальная жизнь 110+',
      'Сопротивление хаосу 26–30% от Essence of Envy',
      'Другие сопротивления по потребности',
    ],
    {
      title: 'Winter Orb Elementalist PoB (3.29)',
      url: 'https://pobb.in/W4yCI3RRdniV',
      notes:
        'Источник описывает Essence of Envy и механику Allflame, с заменой базы при Intangibility выше 25%. Вероятность и стоимость замены не указаны; существующая модель повторов на одной базе неприменима. Количественные требования к остальным сопротивлениям не заданы. Не рассчитывать до проверки метода.',
    },
  ),
  profile(
    'Flicker Strike Slayer — редкий Stygian Vise (исследование)',
    'Flicker Strike Slayer',
    'Belt',
    ['Stygian Vise'],
    [
      '+100 к максимальной жизни',
      '+80% суммарных элементальных сопротивлений',
      '30% увеличенного урона стихий атаками',
    ],
    {
      title: 'Flicker Strike Slayer gear (3.29)',
      url: 'https://odealo.com/articles/trinity-flicker-strike-slayer-build-1',
      notes:
        'Гайд указывает редкую альтернативу, но его PoB использует Arn’s Anguish. При замене на Vengeance Tether без самоцвета PoB показывает 62% огненного сопротивления и снижение DPS примерно на 31%. Редкий пояс требует адаптации остальной сборки; профиль остаётся исследовательским.',
    },
  ),
  profile(
    'Lacerate Gladiator — редкий Stygian Vise (исследование)',
    'Lacerate Gladiator',
    'Belt',
    ['Stygian Vise'],
    ['Элементальные сопротивления по потребности', 'Максимальная жизнь'],
    {
      title: 'Lacerate Gladiator gear (3.29)',
      url: 'https://www.poe-vault.com/guides/lacerate-gladiator-gear-jewels-flasks',
      notes:
        'Редкий пояс — альтернатива уникальному. Порогов, уровня предмета и влияний источник не задаёт; правила сопоставления требуют уточнения.',
    },
  ),
  profile(
    'Spectre Summoner — бюджетный Stygian Vise (исследование)',
    'Spectre Summoner Necromancer',
    'Belt',
    ['Stygian Vise'],
    [
      'Высокая максимальная жизнь',
      'Сопротивления и характеристики по потребности',
    ],
    {
      title: 'Spectre Summoner gear (3.29)',
      url: 'https://www.poe-vault.com/guides/the-spectre-summoner-gear-jewels-flasks',
      notes:
        'Бюджетная редкая альтернатива; основной рекомендованный пояс уникальный. Количественные пороги и параметры базы не указаны; правила сопоставления требуют уточнения.',
    },
  ),
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
