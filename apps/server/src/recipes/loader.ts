import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  RecipeValidationError,
  type LoadedRecipeDefinition,
  validateRecipeDocument,
} from '@poe-worksmith/domain';
import matter from 'gray-matter';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

const ALLOWED_IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.webp',
]);

type LoadedRecipeBase = {
  assets: readonly string[];
  markdown: string;
  sourcePath: string;
};

export type LoadedRecipe = LoadedRecipeBase & {
  definition: LoadedRecipeDefinition;
};

export type RecipeLoaderIssue = {
  file: string;
  message: string;
  path: string;
};

export class RecipeCatalogError extends Error {
  readonly issues: readonly RecipeLoaderIssue[];

  constructor(issues: readonly RecipeLoaderIssue[]) {
    const sorted = [...issues].sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.path.localeCompare(right.path) ||
        left.message.localeCompare(right.message),
    );
    super(
      `Recipe catalog validation failed:\n${sorted
        .map(
          ({ file, message, path: field }) => `- ${file}:${field}: ${message}`,
        )
        .join('\n')}`,
    );
    this.name = 'RecipeCatalogError';
    this.issues = sorted;
  }
}

export async function loadRecipeCatalog(
  catalogPath: string,
): Promise<LoadedRecipe[]> {
  const catalogRoot = path.resolve(catalogPath);
  const recipeFiles = await findRecipeFiles(catalogRoot).catch(
    (error: unknown) => {
      throw new RecipeCatalogError([
        {
          file: '.',
          message: safeErrorMessage(error),
          path: '$catalog',
        },
      ]);
    },
  );
  const loaded: LoadedRecipe[] = [];
  const issues: RecipeLoaderIssue[] = [];

  for (const recipeFile of recipeFiles) {
    try {
      loaded.push(await loadRecipeFile(recipeFile, catalogRoot));
    } catch (error) {
      if (error instanceof RecipeCatalogError) {
        issues.push(...error.issues);
      } else {
        issues.push({
          file: relativePath(catalogRoot, recipeFile),
          message: safeErrorMessage(error),
          path: '$file',
        });
      }
    }
  }

  const firstFileById = new Map<string, string>();
  for (const recipe of loaded) {
    const firstFile = firstFileById.get(recipe.definition.id);
    if (firstFile) {
      issues.push({
        file: recipe.sourcePath,
        message: `Duplicate recipe id "${recipe.definition.id}"; first defined in ${firstFile}`,
        path: 'id',
      });
    } else {
      firstFileById.set(recipe.definition.id, recipe.sourcePath);
    }
  }

  if (issues.length > 0) throw new RecipeCatalogError(issues);
  return loaded.sort(
    (left, right) =>
      left.definition.id.localeCompare(right.definition.id) ||
      left.sourcePath.localeCompare(right.sourcePath),
  );
}

export async function loadRecipeFile(
  recipeFile: string,
  catalogPath = path.dirname(recipeFile),
): Promise<LoadedRecipe> {
  const catalogRoot = path.resolve(catalogPath);
  const absoluteFile = path.resolve(recipeFile);
  const sourcePath = relativePath(catalogRoot, absoluteFile);
  let source: string;
  try {
    source = await readFile(absoluteFile, 'utf8');
  } catch (error) {
    throw new RecipeCatalogError([
      { file: sourcePath, message: safeErrorMessage(error), path: '$file' },
    ]);
  }

  if (!matter.test(source)) {
    throw new RecipeCatalogError([
      {
        file: sourcePath,
        message: 'Missing YAML front matter',
        path: 'frontMatter',
      },
    ]);
  }

  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(source);
  } catch (error) {
    throw new RecipeCatalogError([
      {
        file: sourcePath,
        message: safeErrorMessage(error),
        path: 'frontMatter',
      },
    ]);
  }

  let definition: LoadedRecipeDefinition;
  try {
    definition = validateRecipeDocument(parsed.data);
  } catch (error) {
    if (error instanceof RecipeValidationError) {
      throw new RecipeCatalogError(
        error.issues.map((issue) => ({
          file: sourcePath,
          message: issue.message,
          path: issue.path,
        })),
      );
    }
    throw error;
  }

  const markdown = normalizeMarkdown(parsed.content);
  if (!markdown) {
    throw new RecipeCatalogError([
      {
        file: sourcePath,
        message: 'Markdown body is required',
        path: 'markdown',
      },
    ]);
  }

  const assets = await validateMarkdown(
    markdown,
    path.dirname(absoluteFile),
    catalogRoot,
    sourcePath,
  );

  return { assets, definition, markdown, sourcePath };
}

async function findRecipeFiles(directory: string): Promise<string[]> {
  const entries = (await readdir(directory, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findRecipeFiles(entryPath)));
    } else if (entry.isFile() && entry.name === 'recipe.md') {
      files.push(entryPath);
    }
  }
  return files;
}

async function validateMarkdown(
  markdown: string,
  recipeDirectory: string,
  catalogRoot: string,
  sourcePath: string,
) {
  const tree = unified().use(remarkParse).parse(markdown);
  const definitions = new Map<string, string>();
  const imageUrls: string[] = [];
  const issues: RecipeLoaderIssue[] = [];

  visit(tree, 'definition', (node) => {
    definitions.set(node.identifier.toLowerCase(), node.url);
  });
  visit(tree, 'text', (node) => {
    if (/<\/?[A-Z][A-Za-z0-9_.:-]*(?:\s|\/?>)/.test(node.value)) {
      issues.push({
        file: sourcePath,
        message: 'Raw HTML and JSX are not allowed',
        path: 'markdown',
      });
    }
  });
  visit(tree, 'html', () => {
    issues.push({
      file: sourcePath,
      message: 'Raw HTML and JSX are not allowed',
      path: 'markdown',
    });
  });
  visit(tree, (node) => {
    if (node.type === 'image') {
      imageUrls.push(node.url);
    } else if (node.type === 'imageReference') {
      const url = definitions.get(node.identifier.toLowerCase());
      if (url) {
        imageUrls.push(url);
      } else {
        issues.push({
          file: sourcePath,
          message: `Missing image definition "${node.identifier}"`,
          path: `markdown.images[${imageUrls.length}]`,
        });
      }
    }
  });

  const assets = new Set<string>();
  for (const [index, imageUrl] of imageUrls.entries()) {
    const issuePath = `markdown.images[${index}]`;
    const asset = await validateAsset(
      imageUrl,
      recipeDirectory,
      catalogRoot,
      sourcePath,
      issuePath,
    ).catch((error: unknown) => {
      issues.push({
        file: sourcePath,
        message: safeErrorMessage(error),
        path: issuePath,
      });
      return null;
    });
    if (asset) assets.add(asset);
  }

  if (issues.length > 0) throw new RecipeCatalogError(issues);
  return [...assets].sort();
}

async function validateAsset(
  imageUrl: string,
  recipeDirectory: string,
  catalogRoot: string,
  sourcePath: string,
  issuePath: string,
) {
  if (
    /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(imageUrl) ||
    imageUrl.startsWith('//')
  ) {
    throw new Error('Image source must be a relative local asset');
  }
  if (imageUrl.includes('?') || imageUrl.includes('#')) {
    throw new Error('Image source must not contain a query or fragment');
  }

  let decodedUrl: string;
  try {
    decodedUrl = decodeURIComponent(imageUrl);
  } catch {
    throw new Error('Image source contains invalid URL encoding');
  }

  const absoluteAsset = path.resolve(recipeDirectory, decodedUrl);
  const recipeRelative = path.relative(recipeDirectory, absoluteAsset);
  if (
    recipeRelative === '' ||
    recipeRelative === '..' ||
    recipeRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(recipeRelative)
  ) {
    throw new Error('Image source escapes the recipe directory');
  }
  if (
    !ALLOWED_IMAGE_EXTENSIONS.has(path.extname(absoluteAsset).toLowerCase())
  ) {
    throw new Error('Image must be PNG, JPEG, GIF, WebP, or AVIF');
  }

  let details;
  try {
    details = await lstat(absoluteAsset);
  } catch {
    throw new Error(`Missing asset "${imageUrl}"`);
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`Asset "${imageUrl}" is not a regular file`);
  }

  const assetPath = relativePath(catalogRoot, absoluteAsset);
  if (assetPath.startsWith('../')) {
    throw new RecipeCatalogError([
      {
        file: sourcePath,
        message: 'Image source escapes the recipe catalog',
        path: issuePath,
      },
    ]);
  }
  return assetPath;
}

function normalizeMarkdown(markdown: string) {
  const normalized = markdown.replaceAll('\r\n', '\n').trim();
  return normalized ? `${normalized}\n` : '';
}

function relativePath(root: string, target: string) {
  return path.relative(root, target).split(path.sep).join('/');
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown loader error';
}
