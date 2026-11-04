import { useState, type ReactNode } from 'react';

export function FactoryField({
  name,
  label,
  type = 'text',
  value,
  required = true,
  ...props
}: {
  name: string;
  label: string;
  type?: string;
  value?: string;
  required?: boolean;
  min?: string;
  step?: string;
  maxLength?: number;
}) {
  return (
    <label>
      {label}
      <input
        name={name}
        type={type}
        defaultValue={value}
        required={required}
        {...props}
      />
    </label>
  );
}

export function FactorySelect({
  name,
  label,
  children,
  value,
}: {
  name: string;
  label: string;
  children: ReactNode;
  value?: string;
}) {
  return (
    <label>
      {label}
      <select name={name} defaultValue={value} required>
        {children}
      </select>
    </label>
  );
}

export function TransactionFields({
  prefix = '',
  quantity = true,
  label = 'Actual transaction',
}: {
  prefix?: string;
  quantity?: boolean;
  label?: string;
}) {
  const [currency, setCurrency] = useState('chaos');
  return (
    <fieldset className="factory-fields">
      <legend>{label}</legend>
      {quantity ? (
        <FactoryField
          name={`${prefix}quantity`}
          label="Transaction quantity"
          type="number"
          min="0.000001"
          step="any"
        />
      ) : (
        <input type="hidden" name={`${prefix}quantity`} value="1" />
      )}
      <FactoryField
        name={`${prefix}unitPrice`}
        label={
          quantity
            ? 'Unit price in transaction currency'
            : 'Amount in transaction currency'
        }
        type="number"
        min="0"
        step="any"
      />
      <label>
        Transaction currency
        <select
          name={`${prefix}currency`}
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
            name={`${prefix}chaosPerUnit`}
            label="Chaos per divine at transaction time"
            type="number"
            min="0.000001"
            step="any"
          />
          <FactoryField
            name={`${prefix}rateSource`}
            label="Historical exchange-rate source"
          />
        </>
      ) : (
        <>
          <input type="hidden" name={`${prefix}chaosPerUnit`} value="1" />
          <input
            type="hidden"
            name={`${prefix}rateSource`}
            value="Chaos transaction; no conversion"
          />
        </>
      )}
      <p className="factory-note">
        The original currency and this conversion stay fixed. Today's exchange
        rate will not rewrite this transaction.
      </p>
    </fieldset>
  );
}
