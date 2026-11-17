import { Link, useLocation, type LinkProps } from 'react-router-dom';

const contextKeys = ['recipe', 'league', 'currency', 'range'] as const;

export function selectedRecipe(pathname: string, search: string) {
  const match = /^\/recipes\/([^/]+)$/.exec(pathname);
  try {
    return match
      ? decodeURIComponent(match[1]!)
      : new URLSearchParams(search).get('recipe');
  } catch {
    return null;
  }
}

export function workspaceHref(to: string, pathname: string, search: string) {
  if (!to.startsWith('/') || to.startsWith('//')) return to;
  const target = new URL(to, 'https://worksmith.invalid');
  const current = new URLSearchParams(search);
  const recipe = selectedRecipe(pathname, search);
  if (recipe) current.set('recipe', recipe);
  for (const key of contextKeys) {
    if (!target.searchParams.has(key) && current.has(key))
      target.searchParams.set(key, current.get(key)!);
  }
  if (
    pathname === '/factory' &&
    target.pathname === '/factory' &&
    current.has('batch') &&
    !target.searchParams.has('batch')
  )
    target.searchParams.set('batch', current.get('batch')!);
  const targetRecipe = /^\/recipes\/([^/]+)$/.exec(target.pathname);
  if (targetRecipe && recipe) {
    const nextRecipe = selectedRecipe(target.pathname, '');
    if (nextRecipe) target.searchParams.set('recipe', nextRecipe);
  }
  return target.pathname + target.search + target.hash;
}

export function WorkspaceLink({ to, ...props }: LinkProps) {
  const { pathname, search } = useLocation();
  return (
    <Link
      {...props}
      to={typeof to === 'string' ? workspaceHref(to, pathname, search) : to}
    />
  );
}

export const workspaceSections = [
  {
    path: '/',
    title: 'Что крафтить',
    tabs: [
      ['screener', 'Скринер'],
      ['item', 'Предмет'],
      ['budget', 'Бюджет'],
    ],
  },
  {
    path: '/recipes',
    title: 'Рецепты',
    tabs: [
      ['catalog', 'Каталог'],
      ['recipe', 'Рецепт'],
      ['steps', 'По шагам'],
      ['methods', 'Сравнение методов'],
      ['materials', 'Материалы'],
      ['guides', 'Гайды'],
    ],
  },
  {
    path: '/market',
    title: 'Рынок',
    tabs: [
      ['overview', 'Обзор'],
      ['history', 'График цены'],
      ['mods', 'Цена модов'],
      ['compare', 'Сравнение предметов'],
      ['favorites', 'Избранное'],
    ],
  },
  {
    path: '/factory',
    title: 'Моя мастерская',
    tabs: [
      ['batches', 'Партии'],
      ['batch', 'Партия'],
      ['inventory', 'Предметы'],
      ['sales', 'Продажи'],
    ],
  },
  {
    path: '/settings',
    title: 'Настройки',
    tabs: [
      ['general', 'Основные'],
      ['data', 'Данные'],
    ],
  },
] as const;
