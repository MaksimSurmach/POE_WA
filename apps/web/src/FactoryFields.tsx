import { Input, NativeSelect } from './ui.js';
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
      <Input
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
      <NativeSelect name={name} defaultValue={value} required>
        {children}
      </NativeSelect>
    </label>
  );
}

export function TransactionFields({
  prefix = '',
  quantity = true,
  label = 'Фактическая операция',
  initialAmount,
  initialCurrency = 'chaos',
}: {
  prefix?: string;
  quantity?: boolean;
  label?: string;
  initialAmount?: string;
  initialCurrency?: string;
}) {
  const [currency, setCurrency] = useState(
    initialCurrency === 'divine' ? 'divine' : 'chaos',
  );
  return (
    <fieldset className="factory-fields">
      <legend>{label}</legend>
      {quantity ? (
        <FactoryField
          name={`${prefix}quantity`}
          label="Количество в операции"
          type="number"
          min="0.000001"
          step="any"
        />
      ) : (
        <input type="hidden" name={`${prefix}quantity`} value="1" />
      )}
      <FactoryField
        name={`${prefix}unitPrice`}
        {...(initialAmount === undefined ? {} : { value: initialAmount })}
        label={
          quantity
            ? 'Цена единицы в валюте операции'
            : 'Сумма в валюте операции'
        }
        type="number"
        min="0"
        step="any"
      />
      <label>
        Валюта операции
        <NativeSelect
          name={`${prefix}currency`}
          value={currency}
          onChange={(event) => setCurrency(event.target.value)}
        >
          <option value="chaos">Chaos</option>
          <option value="divine">Divine</option>
        </NativeSelect>
      </label>
      {currency === 'divine' ? (
        <>
          <FactoryField
            name={`${prefix}chaosPerUnit`}
            label="Курс chaos за divine на дату операции"
            type="number"
            min="0.000001"
            step="any"
          />
          <FactoryField
            name={`${prefix}rateSource`}
            label="Источник исторического курса"
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
