import { useState } from 'react';
import { FactoryField } from './FactoryFields.js';

export function CapitalFields() {
  const [currency, setCurrency] = useState('chaos');
  return (
    <>
      <fieldset className="intelligence-fields">
        <FactoryField
          name="capital"
          label="Available capital"
          type="number"
          min="0"
          step="any"
        />
        <FactoryField
          name="reserve"
          label="Desired cash reserve"
          type="number"
          min="0"
          step="any"
        />
        <label>
          Capital currency
          <select
            name="currency"
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
          >
            <option value="chaos">Chaos</option>
            <option value="divine">Divine</option>
          </select>
        </label>
        {currency === 'divine' ? (
          <>
            <FactoryField
              name="chaosPerUnit"
              label="Chaos per divine for this plan"
              type="number"
              min="0"
              step="any"
            />
            <FactoryField
              name="rateSource"
              label="Conversion source or explicit assumption"
              maxLength={200}
            />
          </>
        ) : (
          <>
            <input type="hidden" name="chaosPerUnit" value="1" />
            <input
              type="hidden"
              name="rateSource"
              value="Chaos capital; no conversion"
            />
          </>
        )}
        <FactoryField
          name="maxLossPercent"
          label="Maximum combined risk (%)"
          type="number"
          min="0"
          step="any"
        />
        <FactoryField
          name="maxExposurePercent"
          label="Maximum exposure per recipe (%)"
          type="number"
          min="0"
          step="any"
        />
        <FactoryField
          name="horizonDays"
          label="Investment horizon (days)"
          type="number"
          min="1"
          step="1"
        />
      </fieldset>
      <p className="intelligence-note">
        Combined risk means a modelled cash loss or exceeding the planned P95
        bankroll, assuming all outputs sell at stored valuations. It excludes
        no-sale-within-horizon, selling-price changes, liquidation and holding
        risk. The plan records your conversion source; it does not treat an
        entered rate as a live quote. Production options are complete saved
        simulation objectives. Their tail budgets cannot be multiplied to invent
        a larger batch.
      </p>
    </>
  );
}
