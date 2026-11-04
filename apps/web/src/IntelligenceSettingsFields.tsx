import type { IntelligenceSettings } from '@poe-worksmith/domain';

const groups = [
  {
    title: 'Evidence quality and signal stability',
    fields: [
      [
        'maxSnapshotAgeSeconds',
        'Maximum snapshot age (seconds)',
        60,
        604800,
        1,
      ],
      ['minIndependentSellers', 'Minimum independent sellers', 2, 100, 1],
      ['minConfirmations', 'Required independent confirmations', 2, 10, 1],
      [
        'minObservationGapSeconds',
        'Minimum observation gap (seconds)',
        1,
        86400,
        1,
      ],
      ['cooldownSeconds', 'Signal cooldown (seconds)', 0, 604800, 1],
      ['maxSellerShare', 'Maximum largest-seller share (%)', 0, 100, 100],
      ['minOwnSaleSamples', 'Minimum own confirmed-sale sample', 3, 100, 1],
      ['ownSalesWindowDays', 'Own sales observation window (days)', 1, 365, 1],
    ],
  },
  {
    title: 'Entry, exit and market movement',
    fields: [
      [
        'enterProfitChaos',
        'Enter CRAFT: expected cash result (chaos)',
        0,
        undefined,
        1,
      ],
      [
        'exitProfitChaos',
        'Exit CRAFT: expected cash result (chaos)',
        0,
        undefined,
        1,
      ],
      [
        'enterRiskAdjustedRoiPercent',
        'Enter CRAFT: risk-adjusted ROI (%)',
        0,
        undefined,
        1,
      ],
      [
        'exitRiskAdjustedRoiPercent',
        'Exit CRAFT: risk-adjusted ROI (%)',
        0,
        undefined,
        1,
      ],
      [
        'maxLossProbability',
        'Maximum modelled cash-loss probability (%)',
        0,
        100,
        100,
      ],
      [
        'materialMovePercent',
        'Material price movement trigger (%)',
        0,
        undefined,
        1,
      ],
      [
        'askMovePercent',
        'Comparable asking-price movement trigger (%)',
        0,
        undefined,
        1,
      ],
      [
        'sellerMovePercent',
        'Independent-seller movement trigger (%)',
        0,
        undefined,
        1,
      ],
      [
        'supplyGrowthPercent',
        'Listing-supply growth trigger (%)',
        0,
        undefined,
        1,
      ],
    ],
  },
  {
    title: 'Allocation scenario policy',
    fields: [
      [
        'conservativeRiskFraction',
        'Conservative share of requested risk allowance (%)',
        0,
        100,
        100,
      ],
      [
        'balancedRiskFraction',
        'Balanced share of requested risk allowance (%)',
        0,
        100,
        100,
      ],
      ['inputShockPercent', 'Input-price stress increase (%)', 0, 1000, 1],
    ],
  },
] as const;

export function IntelligenceSettingsFields({
  value,
  errors,
  onChange,
}: {
  value: IntelligenceSettings;
  errors: Record<string, string>;
  onChange: (next: IntelligenceSettings) => void;
}) {
  return (
    <details className="market-admin__setting-group">
      <summary>Production intelligence thresholds</summary>
      <p className="market-admin__help">
        Thresholds govern evidence quality, independent confirmations and
        entry/exit hysteresis. A high asking price alone never qualifies a
        craft. The aggressive allocation scenario uses the full requested risk
        allowance.
      </p>
      {errors.intelligence ? (
        <p role="alert" className="market-admin__error">
          {errors.intelligence}
        </p>
      ) : null}
      {groups.map((group) => (
        <div key={group.title}>
          <h3>{group.title}</h3>
          <div className="market-admin__fields">
            {group.fields.map(([key, label, min, max, scale]) => {
              const error = errors[`intelligence.${key}`];
              const current = value[key];
              return (
                <label key={key} className="market-admin__field">
                  {label}
                  <input
                    name={`intelligence.${key}`}
                    type="number"
                    min={min}
                    max={max}
                    step={
                      typeof current === 'string' || scale === 100 ? 'any' : 1
                    }
                    required
                    value={
                      typeof current === 'string'
                        ? current
                        : Number.isFinite(current)
                          ? current * scale
                          : ''
                    }
                    aria-invalid={Boolean(error)}
                    aria-describedby={`intelligence-${key}-hint`}
                    onChange={(event) =>
                      onChange({
                        ...value,
                        [key]:
                          typeof current === 'string'
                            ? event.target.value
                            : event.target.valueAsNumber / scale,
                      })
                    }
                  />
                  <small
                    id={`intelligence-${key}-hint`}
                    className={error ? 'market-admin__error' : ''}
                  >
                    {error ?? `${min}${max === undefined ? '+' : `–${max}`}`}
                  </small>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </details>
  );
}
