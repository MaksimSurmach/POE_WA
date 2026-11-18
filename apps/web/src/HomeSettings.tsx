import { Button, Input } from './ui.js';
import type {
  MarketAdminSettings,
  MarketAdminSettingsResponse,
} from '@poe-worksmith/contracts';
import { tradePoolMinutesSchema } from '@poe-worksmith/contracts';
import { useMemo, useState } from 'react';

import {
  createHomeSettingsClient,
  validateQuoteAges,
} from './homeSettingsClient.js';

const priorities = [1, 2, 3, 4, 5, 6, 7];
const minuteMs = 60_000;
const ageFields = [
  ['maximumQuoteAgeMs', 'Максимальный возраст цены (минуты)'],
  ['freshnessWarningMs', 'Предупреждать о возрасте (минуты)'],
] as const;

/** Collapsed homepage settings; nothing is requested until it is opened. */
export function HomeSettings({
  client,
  initiallyOpen = false,
}: {
  initiallyOpen?: boolean;
  client?: Pick<
    ReturnType<typeof createHomeSettingsClient>,
    'settings' | 'save'
  >;
}) {
  const api = useMemo(() => client ?? createHomeSettingsClient(), [client]);
  const [settings, setSettings] = useState<MarketAdminSettingsResponse | null>(
    null,
  );
  const [draft, setDraft] = useState<MarketAdminSettings | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function apply(
    operation: () => Promise<MarketAdminSettingsResponse>,
    done: string,
  ) {
    setBusy(true);
    setMessage('');
    try {
      const next = await operation();
      setSettings(next);
      setDraft(next.configured);
      setMessage(done);
    } catch (cause) {
      setMessage(
        cause instanceof Error ? cause.message : 'Settings unavailable.',
      );
    } finally {
      setBusy(false);
    }
  }

  const changes =
    settings && draft
      ? Object.fromEntries(
          ageFields.flatMap(([key]) =>
            settings.configured[key] === draft[key] ? [] : [[key, draft[key]]],
          ),
        )
      : {};
  const editedPools = priorities.filter(
    (priority) =>
      settings?.configured.tradePoolMinutes[priority] !==
      draft?.tradePoolMinutes[priority],
  );
  const dirty = Object.keys(changes).length > 0 || editedPools.length > 0;

  return (
    <section className="market-admin home-settings" aria-label="Settings">
      <details
        className="market-admin__drawer"
        open={initiallyOpen || undefined}
        onToggle={(event) => {
          if (event.currentTarget.open && !settings && !busy)
            void apply(() => api.settings(), '');
        }}
      >
        <summary>
          <h2>Периоды сбора Trade и актуальность цен</h2>
        </summary>
        {settings && draft ? (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              const error = validateQuoteAges(draft);
              if (error) setMessage(error);
              else if (
                !tradePoolMinutesSchema.safeParse(draft.tradePoolMinutes)
                  .success
              )
                setMessage('Укажите период целым положительным числом минут.');
              else
                void apply(async () => {
                  const latest = await api.settings();
                  const updates: Partial<MarketAdminSettings> = { ...changes };
                  if (editedPools.length) {
                    const periods = { ...latest.configured.tradePoolMinutes };
                    for (const priority of editedPools) {
                      const minutes = draft.tradePoolMinutes[priority];
                      if (minutes === undefined) delete periods[priority];
                      else periods[priority] = minutes;
                    }
                    updates.tradePoolMinutes = periods;
                  }
                  const poolConflict = editedPools.find(
                    (p) =>
                      latest.configured.tradePoolMinutes[p] !==
                        settings.configured.tradePoolMinutes[p] &&
                      latest.configured.tradePoolMinutes[p] !==
                        draft.tradePoolMinutes[p],
                  );
                  if (
                    poolConflict ||
                    ageFields.some(
                      ([key]) =>
                        key in changes &&
                        latest.configured[key] !== settings.configured[key] &&
                        latest.configured[key] !== draft[key],
                    )
                  ) {
                    setSettings(latest);
                    setDraft({ ...latest.configured, ...updates });
                    throw new Error(
                      poolConflict
                        ? `Период P${poolConflict} изменился. Текущее значение — ${latest.configured.tradePoolMinutes[poolConflict] ?? 'не задано'}. Проверьте и сохраните ещё раз.`
                        : `Quote ages changed elsewhere: maximum ${latest.configured.maximumQuoteAgeMs / minuteMs} min, warning ${latest.configured.freshnessWarningMs / minuteMs} min. Your draft is kept. Review it and save again.`,
                    );
                  }
                  return api.save(latest.version, updates);
                }, 'Настройки сохранены.');
            }}
          >
            <fieldset disabled={busy}>
              <legend className="visually-hidden">Collection settings</legend>
              <fieldset>
                <legend>Период обхода PoE Trade (минуты)</legend>
                <p className="market-admin__hint">
                  Пустое поле отключает пул. Отключить можно только пул без
                  активных целей и рецептов.
                </p>
                <div className="market-admin__fields">
                  {priorities.map((priority) => (
                    <label className="market-admin__field" key={priority}>
                      Пул P{priority}
                      <Input
                        name={`tradePoolMinutes-${priority}`}
                        type="number"
                        min={1}
                        step={1}
                        value={draft.tradePoolMinutes[priority] ?? ''}
                        onChange={(event) => {
                          const periods = { ...draft.tradePoolMinutes };
                          if (event.target.value === '')
                            delete periods[priority];
                          else periods[priority] = event.target.valueAsNumber;
                          setDraft({ ...draft, tradePoolMinutes: periods });
                        }}
                      />
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="market-admin__fields">
                {ageFields.map(([key, label]) => (
                  <label className="market-admin__field" key={key}>
                    {label}
                    <Input
                      name={key}
                      type="number"
                      required
                      min={1}
                      max={120}
                      step="any"
                      value={
                        Number.isFinite(draft[key]) ? draft[key] / minuteMs : ''
                      }
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          [key]: event.target.valueAsNumber * minuteMs,
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              <div className="market-admin__save">
                <Button type="submit" disabled={!dirty}>
                  Сохранить настройки
                </Button>
              </div>
            </fieldset>
            <p className="market-admin__hint">
              Максимальный возраст цены определяет, можно ли использовать её в
              расчёте прибыли.
            </p>
          </form>
        ) : null}
        <p className="market-admin__hint" role="status">
          {message || (settings ? '' : busy ? 'Загрузка настроек…' : '')}
        </p>
      </details>
    </section>
  );
}
