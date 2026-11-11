import { Button, Input } from './ui.js';
import type {
  MarketAdminSettings,
  MarketAdminSettingsResponse,
} from '@poe-worksmith/contracts';
import { useMemo, useState } from 'react';

import {
  createHomeSettingsClient,
  validateQuoteAges,
} from './homeSettingsClient.js';

const minuteMs = 60_000;
const ageFields = [
  ['maximumQuoteAgeMs', 'Maximum quote age (minutes)'],
  ['freshnessWarningMs', 'Warning age (minutes)'],
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
  const dirty = Object.keys(changes).length > 0;

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
          <h2>Settings</h2>
        </summary>
        {settings && draft ? (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              const error = validateQuoteAges(draft);
              if (error) setMessage(error);
              else
                // Pause/resume elsewhere bumps the version; only the edited
                // ages are sent, so the current pause state is left untouched.
                void apply(async () => {
                  const latest = await api.settings();
                  if (
                    ageFields.some(
                      ([key]) =>
                        key in changes &&
                        latest.configured[key] !== settings.configured[key] &&
                        latest.configured[key] !== draft[key],
                    )
                  ) {
                    setSettings(latest);
                    setDraft({ ...latest.configured, ...changes });
                    throw new Error(
                      `Quote ages changed elsewhere: maximum ${latest.configured.maximumQuoteAgeMs / minuteMs} min, warning ${latest.configured.freshnessWarningMs / minuteMs} min. Your draft is kept. Review it and save again.`,
                    );
                  }
                  return api.save(latest.version, changes);
                }, 'Settings saved.');
            }}
          >
            <fieldset disabled={busy}>
              <legend className="visually-hidden">Collection settings</legend>
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
                  Save settings
                </Button>
              </div>
            </fieldset>
            <p className="market-admin__hint">
              These ages decide when a stored quote is flagged or hidden; they
              do not change how often collection runs. Refresh intervals differ
              by target and data source — Collector details shows what is due
              next. Pause or resume collection from the collector controls.
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
