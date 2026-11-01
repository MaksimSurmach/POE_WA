import { useState } from 'react';
import { marketClient } from './marketClient.js';

export function MarketCatalogImport({
  onImported,
}: {
  onImported: () => void;
}) {
  const [json, setJSON] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  async function submit(dryRun: boolean) {
    setPending(true);
    setMessage('');
    try {
      const result = await marketClient.importCatalog(JSON.parse(json), dryRun);
      setMessage(
        `${result.dryRun ? 'Проверка' : 'Импорт'}: новых ${result.created}, без изменений ${result.unchanged}.`,
      );
      if (!result.dryRun) onImported();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Ошибка импорта');
    } finally {
      setPending(false);
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit(true);
      }}
    >
      <p>
        Версионированный JSON: schemaVersion=1, profiles[]. Повторный импорт
        идемпотентен; прежние версии и снимки сохраняются.
      </p>
      <label>
        Файл каталога
        <input
          type="file"
          accept="application/json,.json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              if (file.size > 2 * 1024 * 1024) {
                setMessage('Максимум 2 MiB');
                return;
              }
              void file.text().then(setJSON);
            }
          }}
        />
      </label>
      <label>
        JSON каталога
        <textarea
          value={json}
          onChange={(event) => setJSON(event.target.value)}
          rows={12}
          required
        />
      </label>
      {message && <p role="status">{message}</p>}
      <button className="market-button" type="submit" disabled={pending}>
        Проверить без записи
      </button>{' '}
      <button
        className="market-button market-button--primary"
        type="button"
        onClick={() => void submit(false)}
        disabled={pending}
      >
        Импортировать каталог
      </button>
    </form>
  );
}
