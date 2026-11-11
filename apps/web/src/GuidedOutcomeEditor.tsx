import { Button, Input, NativeSelect, TextArea } from './ui.js';
import { useState, type FormEvent } from 'react';
import type { OutcomeAnalysisInput } from '@poe-worksmith/domain';
import {
  buildGuidedOutcomeInput,
  emptyGuidedOutcome,
  type GuidedOutcome,
  type GuidedOutcomeDraft,
} from './guidedOutcomeModel.js';

export function modelInputError(error: unknown) {
  if (
    error &&
    typeof error === 'object' &&
    'issues' in error &&
    Array.isArray(error.issues)
  ) {
    return error.issues
      .slice(0, 4)
      .map(
        (issue: { path?: (string | number)[]; message?: string }) =>
          `${issue.path?.join('.') || 'Model'}: ${issue.message || 'Invalid value'}`,
      )
      .join(' · ');
  }
  return error instanceof Error
    ? error.message
    : 'The model could not be saved.';
}

export function GuidedOutcomeEditor({
  league,
  disabled,
  onSave,
}: {
  league: string;
  disabled: boolean;
  onSave(input: OutcomeAnalysisInput): Promise<void>;
}) {
  const [draft, setDraft] = useState<GuidedOutcomeDraft>({
    currency: 'chaos',
    base: '',
    materials: '',
    costSource: '',
    assumptions: '',
    exclusive: false,
    outcomes: [
      emptyGuidedOutcome('outcome-1'),
      emptyGuidedOutcome('outcome-2'),
    ],
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [nextId, setNextId] = useState(3);
  const change = <K extends keyof GuidedOutcomeDraft>(
    key: K,
    value: GuidedOutcomeDraft[K],
  ) => setDraft((current) => ({ ...current, [key]: value }));
  const changeOutcome = <K extends keyof GuidedOutcome>(
    id: string,
    key: K,
    value: GuidedOutcome[K],
  ) =>
    setDraft((current) => ({
      ...current,
      outcomes: current.outcomes.map((outcome) =>
        outcome.id === id ? { ...outcome, [key]: value } : outcome,
      ),
    }));

  async function save(event: FormEvent) {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      await onSave(
        buildGuidedOutcomeInput(draft, league, new Date().toISOString()),
      );
    } catch (failure) {
      setError(modelInputError(failure));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="craft-risk__editor" onSubmit={save}>
      <p className="catalog-price-note">
        One attempt ends in one of the outcomes below. This form does not model
        retries or conditional stages; use the advanced editor for those. Values
        you enter are labelled assumptions unless a resale is explicitly
        confirmed.
      </p>
      <fieldset disabled={disabled || saving}>
        <legend>Cost of every attempt</legend>
        <div className="craft-risk__fields">
          <label>
            Currency
            <NativeSelect
              value={draft.currency}
              onChange={(event) =>
                change('currency', event.target.value as 'chaos' | 'divine')
              }
            >
              <option value="chaos">Chaos</option>
              <option value="divine">Divine</option>
            </NativeSelect>
          </label>
          <label>
            One base
            <Input
              inputMode="decimal"
              maxLength={40}
              value={draft.base}
              onChange={(event) => change('base', event.target.value)}
              placeholder="Required; 0 if free"
            />
          </label>
          <label>
            Materials per attempt
            <Input
              inputMode="decimal"
              maxLength={40}
              value={draft.materials}
              onChange={(event) => change('materials', event.target.value)}
              placeholder="Required; 0 if none"
            />
          </label>
          <label>
            Cost source
            <Input
              value={draft.costSource}
              onChange={(event) => change('costSource', event.target.value)}
              placeholder="Transaction reference or assumption"
              maxLength={2000}
            />
          </label>
        </div>
        <label>
          Assumptions and outcome boundaries
          <TextArea
            rows={2}
            value={draft.assumptions}
            onChange={(event) => change('assumptions', event.target.value)}
            placeholder="Explain which modifier combinations belong to each outcome, the evidence, and all excluded or unknown costs."
            maxLength={2000}
          />
        </label>
      </fieldset>
      {draft.outcomes.map((outcome, index) => (
        <fieldset key={outcome.id} disabled={disabled || saving}>
          <legend>Outcome {index + 1}</legend>
          <div className="craft-risk__fields">
            <label>
              Name / modifier requirements
              <Input
                value={outcome.name}
                onChange={(event) =>
                  changeOutcome(outcome.id, 'name', event.target.value)
                }
                maxLength={2000}
              />
            </label>
            <label>
              Classification
              <NativeSelect
                value={outcome.classification}
                onChange={(event) =>
                  changeOutcome(
                    outcome.id,
                    'classification',
                    event.target.value as GuidedOutcome['classification'],
                  )
                }
              >
                <option value="premium">Premium</option>
                <option value="target">Target</option>
                <option value="imperfect">Good but imperfect</option>
                <option value="salvage">Salvage</option>
                <option value="unusable">Unusable</option>
              </NativeSelect>
            </label>
            <label>
              Probability (0–1)
              <Input
                inputMode="decimal"
                maxLength={40}
                value={outcome.probability}
                onChange={(event) =>
                  changeOutcome(outcome.id, 'probability', event.target.value)
                }
                placeholder="Blank = unknown"
              />
            </label>
            <label>
              Probability source
              <Input
                value={outcome.probabilitySource}
                onChange={(event) =>
                  changeOutcome(
                    outcome.id,
                    'probabilitySource',
                    event.target.value,
                  )
                }
                maxLength={2000}
                placeholder="Required for a numerical probability"
              />
            </label>
            <label>
              Finishing cost for this outcome
              <Input
                inputMode="decimal"
                maxLength={40}
                value={outcome.finishing}
                onChange={(event) =>
                  changeOutcome(outcome.id, 'finishing', event.target.value)
                }
                placeholder="Required; 0 if none"
              />
            </label>
            <label>
              Recovery expense for this outcome
              <Input
                inputMode="decimal"
                maxLength={40}
                value={outcome.recovery}
                onChange={(event) =>
                  changeOutcome(outcome.id, 'recovery', event.target.value)
                }
                placeholder="Required; 0 if none"
              />
            </label>
          </div>
          <div className="craft-risk__checks">
            <label>
              <input
                type="checkbox"
                checked={outcome.targetSuccess}
                onChange={(event) =>
                  changeOutcome(
                    outcome.id,
                    'targetSuccess',
                    event.target.checked,
                  )
                }
              />{' '}
              Meets this recipe's exact target
            </label>
            <label>
              <input
                type="checkbox"
                checked={outcome.sellable}
                onChange={(event) =>
                  changeOutcome(outcome.id, 'sellable', event.target.checked)
                }
              />{' '}
              Sellable
            </label>
          </div>
          {outcome.sellable ? (
            <>
              <div className="craft-risk__fields">
                <label>
                  Resale range: minimum
                  <Input
                    inputMode="decimal"
                    maxLength={40}
                    value={outcome.resaleMin}
                    onChange={(event) =>
                      changeOutcome(outcome.id, 'resaleMin', event.target.value)
                    }
                  />
                </label>
                <label>
                  Resale range: maximum
                  <Input
                    inputMode="decimal"
                    maxLength={40}
                    value={outcome.resaleMax}
                    onChange={(event) =>
                      changeOutcome(outcome.id, 'resaleMax', event.target.value)
                    }
                  />
                </label>
                <label>
                  Resale source
                  <Input
                    value={outcome.resaleSource}
                    onChange={(event) =>
                      changeOutcome(
                        outcome.id,
                        'resaleSource',
                        event.target.value,
                      )
                    }
                    maxLength={2000}
                    placeholder="Transaction reference or valuation assumption"
                  />
                </label>
              </div>
              <label className="craft-risk__checkbox">
                <input
                  type="checkbox"
                  checked={outcome.resaleConfirmed}
                  onChange={(event) =>
                    changeOutcome(
                      outcome.id,
                      'resaleConfirmed',
                      event.target.checked,
                    )
                  }
                />{' '}
                This value is backed by an actual confirmed transaction, not an
                asking price.
              </label>
            </>
          ) : (
            <p className="catalog-price-note">
              No resale revenue is assigned to this outcome. Record any resource
              credits through the advanced editor.
            </p>
          )}
          <Button
            type="button"
            disabled={draft.outcomes.length === 1}
            onClick={() =>
              change(
                'outcomes',
                draft.outcomes.filter((row) => row.id !== outcome.id),
              )
            }
          >
            Remove outcome
          </Button>
        </fieldset>
      ))}
      <Button
        type="button"
        disabled={disabled || saving || draft.outcomes.length >= 16}
        onClick={() => {
          change('outcomes', [
            ...draft.outcomes,
            emptyGuidedOutcome(`outcome-${nextId}`),
          ]);
          setNextId(nextId + 1);
        }}
      >
        Add outcome
      </Button>
      <label className="craft-risk__checkbox">
        <input
          type="checkbox"
          checked={draft.exclusive}
          disabled={disabled || saving}
          onChange={(event) => change('exclusive', event.target.checked)}
        />{' '}
        These outcomes do not overlap and include every possible result. Known
        probabilities must add to exactly 1; unknown residual probability stays
        explicit.
      </label>
      {error ? (
        <p role="alert" className="recipe-warning">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={disabled || saving}>
        {saving ? 'Saving model…' : 'Save new model revision'}
      </Button>
    </form>
  );
}
