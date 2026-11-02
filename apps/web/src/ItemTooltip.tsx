import type { PresentedItem } from '@poe-worksmith/contracts';
import { useEffect, useLayoutEffect, useId, useRef, useState } from 'react';

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
  const [iconFailed, setIconFailed] = useState(false);
  const id = useId();
  const tooltip = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    if (!open || dismissed) return;
    function place() {
      const trigger = preview.current?.getBoundingClientRect();
      const box = tooltip.current?.getBoundingClientRect();
      if (!trigger || !box) return;
      const left = Math.max(
        8,
        Math.min(trigger.left, document.documentElement.clientWidth - box.width - 8),
      );
      const below = trigger.bottom + 6;
      const top =
        below + box.height <= window.innerHeight - 8
          ? below
          : Math.max(8, trigger.top - box.height - 6);
      setPosition({ left, top });
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, dismissed, item]);
  useEffect(
    () => () => {
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
    },
    [],
  );
  const preview = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    function dismissOutside(event: PointerEvent) {
      if (!preview.current?.contains(event.target as Node)) {
        setOpen(false);
        setDismissed(false);
      }
    }
    function dismissEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && open) {
        setOpen(false);
        setDismissed(true);
      }
    }
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('keydown', dismissEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('keydown', dismissEscape);
    };
  }, [open]);
  return (
    <span
      ref={preview}
      className={`item-preview${dismissed ? ' is-dismissed' : ''}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
          setDismissed(false);
        }
      }}
      onMouseEnter={() => {
        if (leaveTimer.current) clearTimeout(leaveTimer.current);
        setOpen(true);
      }}
      onMouseLeave={() => {
        setDismissed(false);
        leaveTimer.current = setTimeout(() => {
          if (!preview.current?.contains(document.activeElement))
            setOpen(false);
        }, 150);
      }}
    >
      <button
        className={`item-preview__trigger item-preview__trigger--${item.rarity ?? 'unknown'}`}
        type="button"
        aria-describedby={open && !dismissed ? id : undefined}
        aria-controls={id}
        aria-expanded={open && !dismissed}
        aria-label={`Preview ${item.role} item: ${item.name}, ${item.itemClass}`}
        onClick={() => {
          setDismissed(false);
          setOpen(true);
        }}
        onFocus={() => {
          setDismissed(false);
          setOpen(true);
        }}
      >
        {item.iconUrl && !iconFailed ? (
          <img src={item.iconUrl} alt="" onError={() => setIconFailed(true)} />
        ) : (
          <span aria-hidden="true">◇</span>
        )}
      </button>
      <span
        className={`item-tooltip${open && !dismissed ? ' is-open' : ''}`}
        ref={tooltip}
        style={position}
        hidden={!open || dismissed}
        id={id}
        role="tooltip"
      >
        <span
          className={`item-tooltip__header item-tooltip__header--${item.rarity ?? 'unknown'}`}
        >
          <strong>{item.name}</strong>
          <span>{item.itemClass}</span>
          <small>
            {item.role === 'target'
              ? 'Target item definition'
              : item.role === 'listing'
                ? 'Observed listed item'
                : item.role === 'material'
                  ? 'Crafting ingredient'
                  : 'Starting base'}
          </small>
        </span>
        {item.itemLevel !== null ? (
          <span className="item-tooltip__property">
            Item Level {item.itemLevel}
          </span>
        ) : null}
        {item.properties.map(({ id: propertyId, label, value }) =>
          propertyId === 'item-level' ? null : (
            <span className="item-tooltip__property" key={propertyId}>
              {label}: {value ?? 'Unknown'}
            </span>
          ),
        )}
        {groups.map(([kind, label]) => {
          const modifiers = item.modifiers.filter(
            (modifier) => modifier.generationType === kind,
          );
          return modifiers.length ? (
            <span className="item-tooltip__mods" key={kind}>
              <strong>{label}</strong>
              {modifiers.map(({ canonicalId, label: text }, index) => (
                <span key={`${canonicalId}-${index}`}>{text}</span>
              ))}
            </span>
          ) : null;
        })}
        {!item.modifiers.length ? (
          <span className="item-tooltip__property">
            No modifier evidence available.
          </span>
        ) : null}
      </span>
    </span>
  );
}
