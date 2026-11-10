import type {
  MarketAdminSettings,
  MarketAdminSettingsResponse,
} from '@poe-worksmith/contracts';
import { useMemo, useState } from 'react';

import {
  createAdminMarketClient,
  settingsChanges,
  validateSettings,
} from './AdminMarketPage.js';

const minuteMs = 60_000;
const ageFields = [
  ['maximumQuoteAgeMs', 'Maximum quote age (minutes)'],
  ['freshnessWarningMs', 'Warning age (minutes)'],
] as const;

/** Collapsed homepage settings; nothing is requested until it is opened. */
export function HomeSettings({
  client,
  operatorToken,
}: {
  operatorToken?: string;
  client?: Pick<
    ReturnType<typeof createAdminMarketClient>,
    'settings' | 'save' | 'pause'
  >;
}) {
  const api = useMemo(
    () => client ?? createAdminMarketClient(fetch, operatorToken),
    [client, operatorToken],
  );
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
    settings && draft ? settingsChanges(settings.configured, draft) : {};
  const dirty = Object.keys(changes).length > 0;
  const paused = settings?.configured.collectionsPaused;

  return (
    <section className="market-admin home-settings" aria-label="Settings">
      <details
        className="market-admin__drawer"
        onToggle={(event) => {
          if (event.currentTarget.open && !settings && !busy)
            void apply(() => api.settings(), '');
        }}
      >
        <summary>
          <h2>Settings</h2>
        </summary>
        {settings && draft ? (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              const errors = Object.values(validateSettings(draft));
              if (errors.length) setMessage(errors.join(' '));
              else
                void apply(
                  () => api.save(settings.version, changes),
                  'Settings saved.',
                );
            }}
          >
            <fieldset disabled={busy}>
              <legend className="visually-hidden">Collection settings</legend>
              <div className="market-admin__fields">
                {ageFields.map(([key, label]) => (
                  <label className="market-admin__field" key={key}>
                    {label}
                    <input
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
                <button type="submit" disabled={!dirty}>
                  Save settings
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void apply(
                      () => api.pause(!paused, settings.version),
                      paused ? 'Collections resumed.' : 'Collections paused.',
                    )
                  }
                >
                  {paused ? 'Resume collections' : 'Pause collections'}
                </button>
              </div>
            </fieldset>
            <p className="market-admin__hint">
              Trade targets refresh hourly, bases every two hours, and material
              prices every 30 minutes. A running job finishes before pause takes
              effect.
            </p>
          </form>
        ) : null}
        <p className="market-admin__hint" role="status">
          {message || (settings ? '' : busy ? 'Loading settings…' : '')}
        </p>
      </details>
    </section>
  );
}
