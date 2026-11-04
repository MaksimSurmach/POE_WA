import source from './data/pohxGuides.json';

export type PohxGuide = {
  id: string;
  title: string;
  category: string;
  base: string;
  summary: string;
  steps: string[];
  materials: string[];
  relatedRecipeIds: string[];
  workInProgress: boolean;
  sourceUrl: string;
  reviewedAt: string;
  sourceLeague: string;
};

export const pohxGuides: readonly PohxGuide[] = source;
export function filterPohxGuides(search: string, category: string) {
  const needle = search.trim().toLocaleLowerCase();
  return pohxGuides.filter(
    (g) =>
      (category === 'all' || g.category === category) &&
      `${g.title} ${g.summary} ${g.base} pohx righteous fire ${g.category}`
        .toLocaleLowerCase()
        .includes(needle),
  );
}
export function materialName(id: string) {
  return id
    .split('-')
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
}
