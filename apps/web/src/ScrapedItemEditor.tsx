import type {
  ScrapedItem,
  ScrapedItemDiagnostic,
  ScrapedItemModifiersResponse,
  ScrapedItemsResponse,
} from '@poe-worksmith/contracts';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { formatTimestamp } from './dateTime.js';
import { ScrapedItemTestPanel } from './ScrapedItemTestPanel.js';
import {
  ScrapedItemsError,
  ScrapedItemsRejected,
  type ScrapedItemsClient,
} from './scrapedItemsClient.js';
import {
  draftFromSpec,
  influenceOptions,
  isDirty,
  partialReasonLabel,
  specFromDraft,
  type ConditionDraft,
  type FieldError,
  type ItemDraft,
} from './scrapedItemsModel.js';
import { Button, Input, NativeSelect } from './ui.js';

type Modifier = ScrapedItemModifiersResponse['data']['modifiers'][number];
type Recipes = ScrapedItemsResponse['data']['recipes'];
type EditorClient = Pick<
  ScrapedItemsClient,
  | 'save'
  | 'link'
  | 'unlink'
  | 'searchModifiers'
  | 'startTest'
  | 'readTest'
  | 'readCapture'
>;

const kindLabels: Record<ConditionDraft['kind'], string> = {
  explicit: 'Explicit',
  fractured: 'Fractured',
  implicit: 'Implicit',
  enchant: 'Enchant',
  pseudo: 'Pseudo',
};
const rarityLabels = {
  normal: 'Normal',
  magic: 'Magic',
  rare: 'Rare',
  unique: 'Unique',
} as const;

function FieldMessage({ id, errors }: { id: string; errors: FieldError[] }) {
  return errors.length ? (
    <span id={id} className="scraped-field-error" role="alert">
      {errors.map(({ message }) => message).join(' ')}
    </span>
  ) : null;
}

/** Searches canonical modifiers; only ones with a Trade mapping can be added. */
function ModifierPicker({
  client,
  gameDataVersion,
  taken,
  onPick,
}: {
  client: Pick<ScrapedItemsClient, 'searchModifiers'>;
  gameDataVersion: string;
  taken: ReadonlySet<string>;
  onPick: (modifier: Modifier) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Modifier[]>([]);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      setStatus('');
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setStatus('Searching…');
      client
        .searchModifiers(query.trim(), gameDataVersion, controller.signal)
        .then((response) => {
          if (controller.signal.aborted) return;
          setResults(response.data.modifiers);
          setStatus(
            response.data.modifiers.length
              ? `${response.data.modifiers.length} modifiers found.`
              : 'No canonical modifier matches.',
          );
        })
        .catch(() => {
          if (!controller.signal.aborted) setStatus('Search is unavailable.');
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, gameDataVersion, query]);
  return (
    <div className="scraped-picker">
      <label htmlFor={`${id}-q`}>Add modifier</label>
      <Input
        id={`${id}-q`}
        type="search"
        value={query}
        autoComplete="off"
        placeholder="Search by canonical name or ID"
        aria-describedby={`${id}-status`}
        onChange={(event) => setQuery(event.target.value)}
      />
      <p
        id={`${id}-status`}
        role="status"
        aria-live="polite"
        className="scraped-hint"
      >
        {status}
      </p>
      {results.length ? (
        <ul className="scraped-picker__results" aria-label="Matching modifiers">
          {results.map((modifier) => (
            <li key={modifier.id}>
              <Button
                type="button"
                disabled={!modifier.tradeMapped || taken.has(modifier.id)}
                onClick={() => {
                  onPick(modifier);
                  setQuery('');
                }}
              >
                <span>
                  {modifier.name ?? modifier.tradeText ?? modifier.id}
                </span>
                <code>{modifier.id}</code>
                <span className="scraped-hint">
                  {taken.has(modifier.id)
                    ? 'Already required'
                    : !modifier.tradeMapped
                      ? 'No Trade mapping — cannot be searched'
                      : [
                          modifier.generationType ?? 'modifier',
                          modifier.requiredLevel === null
                            ? null
                            : `level ${modifier.requiredLevel}`,
                          modifier.nameSource === 'unavailable'
                            ? 'No descriptive metadata'
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ScrapedItemEditor({
  client,
  collectionsPaused,
  item,
  leagueName,
  recipes,
  onItemChanged,
  onReload,
}: {
  client: EditorClient;
  collectionsPaused: boolean;
  item: ScrapedItem;
  leagueName: string | null;
  recipes: Recipes;
  onItemChanged: (item: ScrapedItem) => void;
  onReload: () => Promise<void>;
}) {
  const names = useMemo(
    () => item.modifiers.map(({ name }) => name),
    [item.modifiers],
  );
  const [draft, setDraft] = useState<ItemDraft>(() =>
    draftFromSpec(item.spec, names),
  );
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [diagnostics, setDiagnostics] = useState<ScrapedItemDiagnostic[]>([]);
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [linkChoice, setLinkChoice] = useState('');
  // A new revision (own save, reload after a conflict) replaces the draft; the
  // status message stays so the owner still sees what just happened.
  const latest = useRef({ spec: item.spec, names });
  latest.current = { spec: item.spec, names };
  const shownRevision = useRef(item.revision);
  useEffect(() => {
    if (shownRevision.current === item.revision) return;
    shownRevision.current = item.revision;
    setDraft(draftFromSpec(latest.current.spec, latest.current.names));
    setErrors([]);
    setDiagnostics([]);
  }, [item.revision]);
  const dirty = isDirty(item.spec, draft);
  const heading = useId();
  const role = item.role === 'base' ? 'starting base' : 'finished output';
  const unmapped = item.modifiers.filter(({ tradeMapped }) => !tradeMapped);
  const issuesAt = (path: string) =>
    [
      ...errors,
      ...diagnostics.flatMap((d) =>
        d.path ? [{ path: d.path, message: d.message }] : [],
      ),
    ].filter((issue) => issue.path === path);
  const general = diagnostics.filter((diagnostic) => !diagnostic.path);
  const used = item.recipes.length;
  const linkable = recipes.filter(
    (recipe) =>
      (item.role === 'base' ? recipe.base : recipe.output) !== item.id,
  );

  async function run(
    work: () => Promise<{
      data: { item: ScrapedItem; schedule: 'synchronized' | 'deferred' };
    }>,
    done: string,
  ) {
    setBusy(true);
    setMessage('');
    setDiagnostics([]);
    setConflict(false);
    try {
      const { data } = await work();
      onItemChanged(data.item);
      await onReload();
      setMessage(
        data.schedule === 'synchronized'
          ? `${done} The collector schedule now uses it.`
          : `${done} The collector will apply it on its next synchronization.`,
      );
    } catch (cause) {
      if (cause instanceof ScrapedItemsRejected) {
        setDiagnostics([...cause.diagnostics]);
        setMessage('Nothing was saved. Fix the items listed below.');
      } else if (cause instanceof ScrapedItemsError && cause.conflict) {
        setConflict(true);
        setMessage(
          'This item changed elsewhere since you opened it. Reload it to continue; your draft is not applied.',
        );
      } else
        setMessage(
          cause instanceof Error ? cause.message : 'The change was not saved.',
        );
    } finally {
      setBusy(false);
    }
  }

  function save() {
    const next = specFromDraft(item.spec, draft);
    if (!next.ok) {
      setErrors(next.errors);
      setMessage('Fix the highlighted fields before saving.');
      return;
    }
    setErrors([]);
    void run(
      () =>
        client.save(item.id, {
          expectedRevision: item.revision,
          spec: next.spec,
        }),
      'Saved.',
    );
  }

  const update = (index: number, change: Partial<ConditionDraft>) =>
    setDraft((current) => ({
      ...current,
      conditions: current.conditions.map((condition, at) =>
        at === index ? { ...condition, ...change } : condition,
      ),
    }));
  const role_kinds: ConditionDraft['kind'][] =
    item.role === 'base'
      ? ['explicit', 'fractured', 'implicit']
      : ['explicit', 'fractured', 'implicit', 'enchant', 'pseudo'];

  return (
    <article className="scraped-detail" aria-labelledby={heading}>
      <header className="scraped-detail__header">
        <div>
          <h2 id={heading}>{item.baseName ?? item.baseId}</h2>
          <p className="scraped-hint">
            {role} · revision {item.revision}
            {item.origin === 'owner'
              ? ' · edited by you'
              : ' · from recipe definitions'}
            {leagueName ? ` · ${leagueName}` : ''}
          </p>
          <p className="scraped-hint scraped-id">
            <code>{item.baseId}</code>
          </p>
        </div>
        {item.query.tradeUrl ? (
          <a
            className="scraped-link-button"
            href={item.query.tradeUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Trade search
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        ) : null}
      </header>

      {item.query.status === 'blocked' ? (
        <div className="scraped-alert" role="alert">
          <strong>This search cannot be built.</strong>
          <ul>
            {item.query.diagnostics.map((diagnostic) => (
              <li key={`${diagnostic.code}:${diagnostic.entityId ?? ''}`}>
                <code>{diagnostic.code}</code> {diagnostic.message}
              </li>
            ))}
          </ul>
          <p>
            Nothing is weakened silently: the collector will not scrape this
            search until it compiles.
          </p>
        </div>
      ) : null}
      {unmapped.length ? (
        <p className="scraped-alert" role="alert">
          {unmapped.length} required modifier
          {unmapped.length === 1 ? ' has' : 's have'} no Trade mapping.
        </p>
      ) : null}
      {item.recipes.some(({ definitionChanged }) => definitionChanged) ? (
        <p className="scraped-note" role="note">
          A recipe&apos;s own definition no longer matches this item. The
          configured requirements below are what is scraped.
        </p>
      ) : null}

      <form
        className="scraped-panel"
        noValidate
        aria-labelledby={`${heading}-req`}
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <h3 id={`${heading}-req`}>Requirements</h3>
        <fieldset disabled={busy}>
          <legend className="visually-hidden">Item requirements</legend>
          <div className="scraped-grid">
            <label>
              Item level{item.role === 'base' ? ' (exact)' : ' (minimum)'}
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={100}
                step={1}
                value={draft.itemLevel}
                aria-invalid={issuesAt('item.itemLevel').length > 0}
                aria-describedby={`${heading}-ilvl`}
                onChange={(event) =>
                  setDraft({ ...draft, itemLevel: event.target.value })
                }
              />
              <FieldMessage
                id={`${heading}-ilvl`}
                errors={issuesAt('item.itemLevel')}
              />
            </label>
            <label>
              Rarity
              <NativeSelect
                value={draft.rarity}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    rarity: event.target.value as ItemDraft['rarity'],
                  })
                }
              >
                {Object.entries(rarityLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </label>
          </div>
          <fieldset className="scraped-checks">
            <legend>Item state</legend>
            {(['corrupted', 'fractured', 'synthesised'] as const).map((key) => (
              <label key={key} className="scraped-check">
                <input
                  type="checkbox"
                  checked={draft[key]}
                  onChange={(event) =>
                    setDraft({ ...draft, [key]: event.target.checked })
                  }
                />
                {key[0]!.toUpperCase() + key.slice(1)}
              </label>
            ))}
          </fieldset>
          <fieldset className="scraped-checks">
            <legend>Influences (item must have exactly these)</legend>
            {influenceOptions.map((influence) => (
              <label key={influence} className="scraped-check">
                <input
                  type="checkbox"
                  checked={draft.influences.includes(influence)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      influences: event.target.checked
                        ? [...draft.influences, influence]
                        : draft.influences.filter(
                            (value) => value !== influence,
                          ),
                    })
                  }
                />
                {influence[0]!.toUpperCase() + influence.slice(1)}
              </label>
            ))}
          </fieldset>

          <h4>Modifiers</h4>
          {draft.conditions.length ? (
            <ul className="scraped-conditions">
              {draft.conditions.map((condition, index) => {
                const at = `conditions.${index}`;
                const mapped = item.modifiers[index]?.tradeMapped !== false;
                const described = item.modifiers[index];
                const label =
                  condition.name ??
                  described?.tradeText ??
                  condition.modId ??
                  condition.modFamilyId;
                return (
                  <li
                    key={`${condition.kind}:${condition.modId ?? condition.modFamilyId}`}
                    className="scraped-condition"
                  >
                    <div className="scraped-condition__name">
                      <strong>{label}</strong>
                      <code>{condition.modId ?? condition.modFamilyId}</code>
                      {mapped ? null : (
                        <span className="scraped-badge scraped-badge--danger">
                          No Trade mapping
                        </span>
                      )}
                      {described?.nameSource === 'unavailable' ? (
                        <span className="scraped-badge">
                          No descriptive metadata
                        </span>
                      ) : null}
                    </div>
                    <label>
                      Type
                      <NativeSelect
                        value={condition.kind}
                        onChange={(event) =>
                          update(index, {
                            kind: event.target.value as ConditionDraft['kind'],
                          })
                        }
                      >
                        {role_kinds.map((kind) => (
                          <option key={kind} value={kind}>
                            {kindLabels[kind]}
                          </option>
                        ))}
                      </NativeSelect>
                    </label>
                    <label>
                      Minimum value
                      <Input
                        type="number"
                        inputMode="decimal"
                        step="any"
                        value={condition.minimumValue}
                        aria-invalid={issuesAt(`${at}.minimumValue`).length > 0}
                        aria-describedby={`${heading}-${index}-min`}
                        onChange={(event) =>
                          update(index, { minimumValue: event.target.value })
                        }
                      />
                      <FieldMessage
                        id={`${heading}-${index}-min`}
                        errors={issuesAt(`${at}.minimumValue`)}
                      />
                    </label>
                    <label>
                      Maximum value
                      <Input
                        type="number"
                        inputMode="decimal"
                        step="any"
                        value={condition.maximumValue}
                        aria-invalid={issuesAt(`${at}.maximumValue`).length > 0}
                        aria-describedby={`${heading}-${index}-max`}
                        onChange={(event) =>
                          update(index, { maximumValue: event.target.value })
                        }
                      />
                      <FieldMessage
                        id={`${heading}-${index}-max`}
                        errors={issuesAt(`${at}.maximumValue`)}
                      />
                    </label>
                    <label>
                      Tier
                      <NativeSelect
                        value={condition.tierMode}
                        onChange={(event) =>
                          update(index, {
                            tierMode: event.target
                              .value as ConditionDraft['tierMode'],
                          })
                        }
                      >
                        <option value="any">Any tier</option>
                        <option value="exact">Exact tier</option>
                        <option value="range">Tier range</option>
                      </NativeSelect>
                    </label>
                    {condition.tierMode === 'exact' ? (
                      <label>
                        Exact tier (1–20)
                        <Input
                          type="number"
                          min={1}
                          max={20}
                          step={1}
                          value={condition.exactTier}
                          aria-invalid={issuesAt(`${at}.exactTier`).length > 0}
                          aria-describedby={`${heading}-${index}-tier`}
                          onChange={(event) =>
                            update(index, { exactTier: event.target.value })
                          }
                        />
                        <FieldMessage
                          id={`${heading}-${index}-tier`}
                          errors={issuesAt(`${at}.exactTier`)}
                        />
                      </label>
                    ) : null}
                    {condition.tierMode === 'range' ? (
                      <>
                        <label>
                          Best tier (lowest number)
                          <Input
                            type="number"
                            min={1}
                            max={20}
                            step={1}
                            value={condition.minimumTier}
                            aria-invalid={
                              issuesAt(`${at}.minimumTier`).length > 0
                            }
                            aria-describedby={`${heading}-${index}-mint`}
                            onChange={(event) =>
                              update(index, { minimumTier: event.target.value })
                            }
                          />
                          <FieldMessage
                            id={`${heading}-${index}-mint`}
                            errors={issuesAt(`${at}.minimumTier`)}
                          />
                        </label>
                        <label>
                          Worst tier (highest number)
                          <Input
                            type="number"
                            min={1}
                            max={20}
                            step={1}
                            value={condition.maximumTier}
                            aria-invalid={
                              issuesAt(`${at}.maximumTier`).length > 0
                            }
                            aria-describedby={`${heading}-${index}-maxt`}
                            onChange={(event) =>
                              update(index, { maximumTier: event.target.value })
                            }
                          />
                          <FieldMessage
                            id={`${heading}-${index}-maxt`}
                            errors={issuesAt(`${at}.maximumTier`)}
                          />
                        </label>
                      </>
                    ) : null}
                    <Button
                      type="button"
                      aria-label={`Remove ${label}`}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          conditions: draft.conditions.filter(
                            (_, at) => at !== index,
                          ),
                        })
                      }
                    >
                      Remove
                    </Button>
                    <FieldMessage
                      id={`${heading}-${index}-item`}
                      errors={issuesAt(at)}
                    />
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="scraped-hint">
              No modifier is required: any {role} of this base matches.
            </p>
          )}
          <ModifierPicker
            client={client}
            gameDataVersion={item.spec.gameDataVersion}
            taken={
              new Set(
                draft.conditions.flatMap(({ modId }) => (modId ? [modId] : [])),
              )
            }
            onPick={(modifier) =>
              setDraft({
                ...draft,
                conditions: [
                  ...draft.conditions,
                  {
                    kind: 'explicit',
                    modId: modifier.id,
                    name: modifier.name,
                    minimumValue: '',
                    maximumValue: '',
                    tierMode: 'any',
                    exactTier: '',
                    minimumTier: '',
                    maximumTier: '',
                  },
                ],
              })
            }
          />
        </fieldset>

        {general.length ? (
          <ul className="scraped-alert" role="alert">
            {general.map((diagnostic) => (
              <li
                key={`${diagnostic.code}:${diagnostic.entityId ?? ''}:${diagnostic.message}`}
              >
                <code>{diagnostic.code}</code> {diagnostic.message}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="scraped-impact">
          Saving changes the search for {used} recipe{used === 1 ? '' : 's'}
          {item.sharedQuery.recipes.length
            ? ` and, through the same search, ${item.sharedQuery.recipes.length} more`
            : ''}
          . It starts a new capture history; earlier captures stay with the old
          search.
        </p>
        <div className="scraped-actions">
          <Button
            type="submit"
            variant="primary"
            liveAction
            disabled={busy || !dirty}
          >
            {busy ? 'Saving…' : 'Save requirements'}
          </Button>
          <Button
            type="button"
            disabled={busy || !dirty}
            onClick={() => {
              setDraft(draftFromSpec(item.spec, names));
              setErrors([]);
              setDiagnostics([]);
              setMessage('');
            }}
          >
            Discard changes
          </Button>
          {conflict ? (
            <Button type="button" onClick={() => void onReload()}>
              Reload item
            </Button>
          ) : null}
        </div>
        <p role="status" aria-live="polite" className="scraped-message">
          {message}
        </p>
      </form>

      <section className="scraped-panel" aria-labelledby={`${heading}-rec`}>
        <h3 id={`${heading}-rec`}>Recipes using this search</h3>
        {item.recipes.length ? (
          <table className="scraped-table">
            <caption className="visually-hidden">Linked recipes</caption>
            <thead>
              <tr>
                <th scope="col">Recipe</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {item.recipes.map((recipe) => (
                <tr key={recipe.id}>
                  <td>
                    <Link to={`/recipes/${encodeURIComponent(recipe.id)}`}>
                      {recipe.title}
                    </Link>
                  </td>
                  <td>
                    {recipe.definitionChanged
                      ? 'Recipe definition differs from this item'
                      : 'Matches its recipe'}
                  </td>
                  <td>
                    <Button
                      type="button"
                      liveAction
                      aria-label={`Unlink ${recipe.title}`}
                      disabled={busy || used < 2 || dirty}
                      onClick={() =>
                        void run(
                          () =>
                            client.unlink(item.id, recipe.id, item.revision),
                          `${recipe.title} now has its own copy of this search.`,
                        )
                      }
                    >
                      Unlink
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="scraped-hint">
            No active recipe uses this item, so the collector does not scrape
            it.
          </p>
        )}
        {used < 2 && used > 0 ? (
          <p className="scraped-hint">
            Unlinking needs a second recipe; this item has only one.
          </p>
        ) : null}
        {item.sharedQuery.recipes.length ? (
          <div className="scraped-shared">
            <h4>Also served by the same search</h4>
            <p className="scraped-hint">
              Another item compiles to this exact search, so these recipes
              receive the same listings:
            </p>
            <ul>
              {item.sharedQuery.recipes.map((recipe) => (
                <li key={`${recipe.role}:${recipe.id}`}>
                  {recipe.title} ({recipe.role})
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="scraped-link-form">
          <label>
            Link another recipe
            <NativeSelect
              value={linkChoice}
              disabled={busy || dirty}
              onChange={(event) => setLinkChoice(event.target.value)}
            >
              <option value="">Choose a recipe…</option>
              {linkable.map((recipe) => (
                <option key={recipe.id} value={recipe.id}>
                  {recipe.title}
                </option>
              ))}
            </NativeSelect>
          </label>
          <Button
            type="button"
            liveAction
            disabled={busy || dirty || linkChoice === ''}
            onClick={() =>
              void run(
                () =>
                  client.link(item.id, {
                    expectedRevision: item.revision,
                    recipeId: linkChoice,
                  }),
                'Recipe linked.',
              ).then(() => setLinkChoice(''))
            }
          >
            Link recipe
          </Button>
        </div>
        <p className="scraped-hint">
          Linking moves that recipe&apos;s {role} search onto this item. Only
          recipes for the same base can be linked.
          {dirty ? ' Save or discard your edits first.' : ''}
        </p>
      </section>

      <section className="scraped-panel" aria-labelledby={`${heading}-col`}>
        <h3 id={`${heading}-col`}>Collection</h3>
        {item.schedule ? (
          <dl className="scraped-facts">
            <div className="scraped-fact">
              <dt>Schedule</dt>
              <dd>{item.schedule.enabled ? 'Enabled' : 'Disabled'}</dd>
            </div>
            <div className="scraped-fact">
              <dt>Every</dt>
              <dd>{item.schedule.intervalMinutes} min</dd>
            </div>
            <div className="scraped-fact">
              <dt>Next due</dt>
              <dd>{formatTimestamp(item.schedule.nextDueAt)}</dd>
            </div>
            <div className="scraped-fact">
              <dt>Last result</dt>
              <dd>
                {item.schedule.lastStatus ?? 'Never run'}
                {item.schedule.lastError ? ` (${item.schedule.lastError})` : ''}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="scraped-hint">
            The collector has no schedule for this exact search yet. It is
            created when the collector applies the saved configuration.
          </p>
        )}
        {item.latestCapture ? (
          <dl className="scraped-facts">
            <div className="scraped-fact">
              <dt>Reported by Trade</dt>
              <dd>{item.latestCapture.reportedTotal}</dd>
            </div>
            <div className="scraped-fact">
              <dt>Listings fetched</dt>
              <dd>{item.latestCapture.fetched}</dd>
            </div>
            <div className="scraped-fact">
              <dt>Coverage</dt>
              <dd>
                {item.latestCapture.coverage === 'complete'
                  ? 'Complete'
                  : 'Partial'}
              </dd>
            </div>
            {item.latestCapture.partialReason ? (
              <div className="scraped-fact">
                <dt>Partial because</dt>
                <dd>{partialReasonLabel(item.latestCapture.partialReason)}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </section>

      <ScrapedItemTestPanel
        client={client}
        dirty={dirty}
        item={item}
        paused={collectionsPaused}
        onFinished={() => void onReload()}
      />
    </article>
  );
}
