import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { validRecipeV1Fixture } from '@poe-worksmith/domain/fixtures';
import matter from 'gray-matter';
import { afterEach, describe, expect, it } from 'vitest';

import { loadRecipeCatalog, RecipeCatalogError } from './loader.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createCatalog() {
  const directory = await mkdtemp(path.join(tmpdir(), 'poe-recipes-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeRecipe(
  catalog: string,
  directory: string,
  definition: Record<string, unknown>,
  markdown = '# Guide\n\nCraft carefully.\n',
) {
  const recipeDirectory = path.join(catalog, directory);
  await mkdir(recipeDirectory, { recursive: true });
  await writeFile(
    path.join(recipeDirectory, 'recipe.md'),
    matter.stringify(markdown, definition),
  );
  return recipeDirectory;
}

function expectCatalogError(error: unknown) {
  expect(error).toBeInstanceOf(RecipeCatalogError);
  return error as RecipeCatalogError;
}

describe('Markdown recipe loader', () => {
  it('loads every recipe in deterministic id order and keeps Markdown separate', async () => {
    const catalog = await createCatalog();
    await writeRecipe(catalog, 'z-recipe', {
      ...validRecipeV1Fixture,
      id: 'z-recipe',
      title: 'Z Recipe',
    });
    await writeRecipe(
      catalog,
      'a-recipe',
      { ...validRecipeV1Fixture, id: 'a-recipe', title: 'A Recipe' },
      '# A guide\r\n\r\nBody.\r\n',
    );

    const recipes = await loadRecipeCatalog(catalog);

    expect(recipes.map(({ definition }) => definition.id)).toEqual([
      'a-recipe',
      'z-recipe',
    ]);
    expect(recipes[0]).toMatchObject({
      markdown: '# A guide\n\nBody.\n',
      sourcePath: 'a-recipe/recipe.md',
    });
    expect(recipes[0]?.definition).not.toHaveProperty('markdown');
  });

  it('collects direct and referenced local images in stable order', async () => {
    const catalog = await createCatalog();
    const directory = await writeRecipe(
      catalog,
      'images',
      validRecipeV1Fixture,
      '# Guide\n\n![B](images/b.png)\n![A][diagram]\n![B again](images/b.png)\n\n[diagram]: images/a.webp\n',
    );
    await mkdir(path.join(directory, 'images'));
    await Promise.all([
      writeFile(path.join(directory, 'images/a.webp'), 'a'),
      writeFile(path.join(directory, 'images/b.png'), 'b'),
    ]);

    const [recipe] = await loadRecipeCatalog(catalog);

    expect(recipe?.assets).toEqual([
      'images/images/a.webp',
      'images/images/b.png',
    ]);
  });

  it('includes source file and field path for schema failures', async () => {
    const catalog = await createCatalog();
    await writeRecipe(catalog, 'invalid', {
      ...validRecipeV1Fixture,
      materials: [
        { ...validRecipeV1Fixture.materials[0], quantityPerAttempt: 0 },
      ],
    });

    await expect(loadRecipeCatalog(catalog)).rejects.toSatisfy(
      (error: unknown) => {
        const catalogError = expectCatalogError(error);
        expect(catalogError.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: 'invalid/recipe.md',
              path: 'materials[0].quantityPerAttempt',
            }),
          ]),
        );
        return true;
      },
    );
  });

  it('rejects missing assets and image paths outside the recipe directory', async () => {
    const catalog = await createCatalog();
    await writeRecipe(
      catalog,
      'missing',
      validRecipeV1Fixture,
      '# Guide\n\n![Missing](images/missing.png)\n',
    );
    await writeRecipe(
      catalog,
      'escape',
      { ...validRecipeV1Fixture, id: 'escape' },
      '# Guide\n\n![Escape](../secret.png)\n',
    );

    await expect(loadRecipeCatalog(catalog)).rejects.toSatisfy(
      (error: unknown) => {
        const messages = expectCatalogError(error).issues.map(
          ({ message }) => message,
        );
        expect(messages).toEqual(
          expect.arrayContaining([
            'Missing asset "images/missing.png"',
            'Image source escapes the recipe directory',
          ]),
        );
        return true;
      },
    );
  });

  it('rejects duplicate recipe IDs with both source locations', async () => {
    const catalog = await createCatalog();
    await writeRecipe(catalog, 'first', validRecipeV1Fixture);
    await writeRecipe(catalog, 'second', validRecipeV1Fixture);

    await expect(loadRecipeCatalog(catalog)).rejects.toSatisfy(
      (error: unknown) => {
        const [issue] = expectCatalogError(error).issues;
        expect(issue).toMatchObject({ file: 'second/recipe.md', path: 'id' });
        expect(issue?.message).toContain('first/recipe.md');
        return true;
      },
    );
  });

  it('rejects raw HTML or JSX without executing it', async () => {
    const catalog = await createCatalog();
    await writeRecipe(
      catalog,
      'unsafe',
      validRecipeV1Fixture,
      '# Guide\n\n<Component onClick={() => run()} />\n',
    );

    await expect(loadRecipeCatalog(catalog)).rejects.toSatisfy(
      (error: unknown) => {
        expect(expectCatalogError(error).issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              message: 'Raw HTML and JSX are not allowed',
              path: 'markdown',
            }),
          ]),
        );
        return true;
      },
    );
  });

  it('allows JSX-looking text inside inert code fences', async () => {
    const catalog = await createCatalog();
    await writeRecipe(
      catalog,
      'code-sample',
      validRecipeV1Fixture,
      '# Guide\n\n```tsx\n<Component />\n```\n',
    );

    await expect(loadRecipeCatalog(catalog)).resolves.toHaveLength(1);
  });

  it('rejects missing, malformed, and body-less recipe content', async () => {
    const catalog = await createCatalog();
    const missing = path.join(catalog, 'missing-frontmatter');
    const malformed = path.join(catalog, 'malformed-frontmatter');
    await mkdir(missing);
    await mkdir(malformed);
    await writeFile(path.join(missing, 'recipe.md'), '# Guide\n');
    await writeFile(
      path.join(malformed, 'recipe.md'),
      '---\ntitle: [invalid\n---\n# Guide\n',
    );
    await writeRecipe(
      catalog,
      'empty-body',
      {
        ...validRecipeV1Fixture,
        id: 'empty-body',
      },
      '',
    );

    await expect(loadRecipeCatalog(catalog)).rejects.toSatisfy(
      (error: unknown) => {
        const issues = expectCatalogError(error).issues;
        expect(issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: 'empty-body/recipe.md',
              path: 'markdown',
            }),
            expect.objectContaining({
              file: 'malformed-frontmatter/recipe.md',
              path: 'frontMatter',
            }),
            expect.objectContaining({
              file: 'missing-frontmatter/recipe.md',
              path: 'frontMatter',
            }),
          ]),
        );
        return true;
      },
    );
  });
});
