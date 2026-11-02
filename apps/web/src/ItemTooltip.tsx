import type { PresentedItem } from '@poe-worksmith/contracts';
import { useEffect, useId, useRef, useState } from 'react';

const groups = [
  ['implicit', 'Implicit modifiers'],
  ['prefix', 'Prefixes'],
  ['suffix', 'Suffixes'],
  ['enchant', 'Enchantments'],
  ['other', 'Other modifiers'],
] as const;

export function ItemTooltip({ item }: { item: PresentedItem }) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const id = useId();
  const preview = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    function dismissOutside(event: PointerEvent) {
      if (!preview.current?.contains(event.target as Node)) {
        setOpen(false);
        setDismissed(false);
      }
    }
    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, []);
  return (
    <span
      ref={preview}
      className={`item-preview${dismissed ? ' is-dismissed' : ''}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setOpen(false);
          setDismissed(true);
        }
      }}
      onMouseLeave={() => setDismissed(false)}
    >
      <button
        className={`item-preview__trigger item-preview__trigger--${item.rarity ?? 'unknown'}`}
        type="button"
        aria-describedby={id}
        aria-controls={id}
        aria-expanded={open}
        aria-label={`Preview target item: ${item.name}, ${item.itemClass}`}
        onClick={() => {
          setDismissed(open);
          setOpen((value) => !value);
        }}
        onFocus={() => setDismissed(false)}
      >
        {item.iconUrl ? (
          <img src={item.iconUrl} alt="" />
        ) : (
          <span aria-hidden="true">◇</span>
        )}
      </button>
      <span
        className={`item-tooltip${open && !dismissed ? ' is-open' : ''}`}
        id={id}
        role="tooltip"
      >
        <span
          className={`item-tooltip__header item-tooltip__header--${item.rarity ?? 'unknown'}`}
        >
          <strong>{item.name}</strong>
          <span>{item.itemClass}</span>
          <small>Target item definition</small>
        </span>
        {item.itemLevel !== null ? (
          <span className="item-tooltip__property">
            Item Level {item.itemLevel}
          </span>
        ) : null}
        {item.properties.map(({ id: propertyId, label, value }) => (
          <span className="item-tooltip__property" key={propertyId}>
            {label}: {value ?? 'Unknown'}
          </span>
        ))}
        {groups.map(([kind, label]) => {
          const modifiers = item.modifiers.filter(
            (modifier) => modifier.generationType === kind,
          );
          return modifiers.length ? (
            <span className="item-tooltip__mods" key={kind}>
              <strong>{label}</strong>
              {modifiers.map(({ canonicalId, label: text }) => (
                <span key={canonicalId}>{text}</span>
              ))}
            </span>
          ) : null;
        })}
        {!item.modifiers.length ? (
          <span className="item-tooltip__property">
            Target modifiers are not available.
          </span>
        ) : null}
      </span>
    </span>
  );
}
