import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { RecipeDetailView } from '@poe-worksmith/contracts';
import { createApiClient } from './apiClient.js';
import { Money, StatusPanel } from './components.js';
import { Button, NativeSelect, TableSurface } from './ui.js';
import { WorkspaceLink as Link } from './workspaceNavigation.js';
import { FavoriteButton, Watchlist } from './Watchlist.js';
import { ItemTooltip } from './ItemTooltip.js';

const api = createApiClient();
export function MarketAnalysis({ view }: { view: string }) {
  const [params] = useSearchParams();
  const id = params.get('recipe');
  const [detail, setDetail] = useState<RecipeDetailView | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [offer, setOffer] = useState('');
  useEffect(() => {
    setDetail(null);
    setFailed(false);
    setOffer('');
    if (!id || view !== 'compare') return;
    let active = true;
    void api
      .getRecipe(id)
      .then((response) => {
        if (active) {
          setDetail(response.data);
          setFailed(!response.data);
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [id, view, revision]);
  if (view === 'favorites') return <Watchlist />;
  if (view === 'mods')
    return (
      <section>
        <h1>Цена модов</h1>
        <StatusPanel tone="info" title="Недостаточно сопоставимых наблюдений">
          API сохраняет цены точных целей. Для оценки отдельного модификатора
          нужны группы предметов с одинаковой базой, лигой, ограничениями и
          отличием только в этом моде. Таких групп и расчёта надбавки сейчас
          нет.
        </StatusPanel>
        <Link to="/market">К реальным рыночным наблюдениям</Link>
      </section>
    );
  if (!id)
    return (
      <section>
        <h1>Сравнение предметов</h1>
        <StatusPanel tone="info" title="Выберите цель на рынке">
          Откройте историю выбранного предмета или выберите рецепт в скринере.
        </StatusPanel>
        <Link to="/market">Выбрать цель</Link>
      </section>
    );
  if (failed)
    return (
      <StatusPanel tone="danger" title="Сравнение недоступно">
        <Button onClick={() => setRevision((value) => value + 1)}>
          Повторить
        </Button>
      </StatusPanel>
    );
  if (!detail)
    return <StatusPanel tone="info" title="Загрузка выбранной цели" />;
  const listings = detail.snapshot?.listings ?? [];
  const selected = listings.find((value) => value.id === offer);
  return (
    <section>
      <h1>Сравнение предметов</h1>
      <p>
        {detail.recipe.title} · {detail.gameVersion} ·{' '}
        {detail.method.priceSources[0]?.league ?? 'Лига источника неизвестна'}
      </p>
      <FavoriteButton recipeId={id} />
      <div className="workspace-actions">
        <Link to={`/recipes/${encodeURIComponent(id)}?view=item`}>
          Целевой предмет
        </Link>
        <Link to={`/market?view=history&recipe=${encodeURIComponent(id)}`}>
          История цены
        </Link>
      </div>
      {detail.evaluation.status === 'stale' ? (
        <p className="recipe-warning">
          Снимок устарел. Объявление может быть недоступно.
        </p>
      ) : null}
      {listings.length ? (
        <label className="catalog-filter">
          Предложение
          <NativeSelect
            value={offer}
            onChange={(event) => setOffer(event.target.value)}
          >
            <option value="">Выберите объявление</option>
            {listings.map((listing) => (
              <option key={listing.id} value={listing.id}>
                {listing.id} · {listing.price.amount} {listing.price.currency}
              </option>
            ))}
          </NativeSelect>
        </label>
      ) : (
        <StatusPanel
          tone="info"
          title="Нет сохранённых объявлений для сравнения"
        >
          Агрегированные asking prices не содержат модификаторов конкретного
          предмета. Дождитесь подходящего снимка.
        </StatusPanel>
      )}
      <div className="comparison-grid">
        <div>
          <h2>Требования цели</h2>
          <ItemTooltip item={detail.presentation.target} />
          <p>
            {detail.base.name} · {detail.base.requirements.join(' · ')}
          </p>
        </div>
        <div>
          <h2>Выбранное предложение</h2>
          {selected ? (
            <>
              <Money price={selected.price} />
              {selected.itemPreview ? (
                <ItemTooltip item={selected.itemPreview} />
              ) : (
                <p>Подробности предмета не сохранены.</p>
              )}
            </>
          ) : (
            <p>Предложение ещё не выбрано.</p>
          )}
        </div>
      </div>
      <div
        className="data-scroll"
        role="region"
        aria-label="Сравнение модификаторов"
        tabIndex={0}
      >
        <TableSurface>
          <table className="table__content">
            <thead>
              <tr>
                <th scope="col">Целевой модификатор</th>
                <th scope="col">Наблюдение в предложении</th>
              </tr>
            </thead>
            <tbody>
              {detail.presentation.target.modifiers.map((mod) => (
                <tr key={mod.canonicalId}>
                  <th scope="row">{mod.label}</th>
                  <td>
                    {!selected?.itemPreview
                      ? 'Неизвестно'
                      : selected.itemPreview.modifiers.some(
                            (candidate) =>
                              candidate.canonicalId === mod.canonicalId,
                          )
                        ? 'Модификатор присутствует; диапазон проверьте по предмету'
                        : 'В сохранённых модификаторах отсутствует'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableSurface>
      </div>
      <p className="catalog-price-note">
        Сопоставление показывает сохранённые модификаторы, не проверяет числовые
        диапазоны. Импорт пользовательского предмета недоступен: в текущем API
        нет соответствующего парсера. Совпадение названия не подтверждает
        выполнение требований.
      </p>
    </section>
  );
}
