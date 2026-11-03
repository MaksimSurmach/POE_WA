import { z } from 'zod';

const rangeSchema = z.object({
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
});
const groupsSchema = z.array(
  z
    .object({
      type: z.string(),
      filters: z.array(
        z
          .object({
            id: z.string(),
            value: rangeSchema.optional(),
            disabled: z.boolean().optional(),
          })
          .passthrough(),
      ),
    })
    .passthrough(),
);
type Range = z.infer<typeof rangeSchema>;

export function isNativeTradeFilter(id: string) {
  return [
    'armour.es',
    'socket.links',
    'misc.quality',
    'misc.base_defence_percentile',
  ].includes(id);
}

/** Native item properties are executable constraints, never provider stat IDs. */
export function splitNativeTradeFilters(input: unknown) {
  const groups = groupsSchema.parse(input);
  const seen = new Set<string>();
  const filters: {
    armour_filters?: {
      filters: { es?: Range; base_defence_percentile?: Range };
    };
    socket_filters?: { filters: { links: Range } };
    misc_filters?: { filters: { quality: Range } };
  } = {};
  for (const group of groups) {
    for (const stat of group.filters.filter((s) => isNativeTradeFilter(s.id))) {
      const values = Object.values(stat.value ?? {});
      const maximum =
        stat.id === 'socket.links'
          ? 6
          : ['misc.quality', 'misc.base_defence_percentile'].includes(stat.id)
            ? 100
            : 1e9;
      if (
        group.type !== 'and' ||
        stat.disabled ||
        seen.has(stat.id) ||
        values.length === 0 ||
        values.some(
          (n) =>
            n === undefined || n < 0 || n > maximum || !Number.isInteger(n),
        ) ||
        (stat.value?.min !== undefined &&
          stat.value.max !== undefined &&
          stat.value.min > stat.value.max)
      ) {
        throw new Error('TRADE_NATIVE_FILTER_INVALID');
      }
      seen.add(stat.id);
      const value = rangeSchema.parse(stat.value);
      if (stat.id === 'armour.es')
        filters.armour_filters = {
          filters: { ...filters.armour_filters?.filters, es: value },
        };
      else if (stat.id === 'misc.base_defence_percentile')
        filters.armour_filters = {
          filters: {
            ...filters.armour_filters?.filters,
            base_defence_percentile: value,
          },
        };
      else if (stat.id === 'socket.links')
        filters.socket_filters = { filters: { links: value } };
      else filters.misc_filters = { filters: { quality: value } };
    }
  }
  return {
    filters,
    stats: groups
      .map((group) => ({
        ...group,
        filters: group.filters.filter((stat) => !isNativeTradeFilter(stat.id)),
      }))
      .filter((group) => group.filters.length > 0),
  };
}
