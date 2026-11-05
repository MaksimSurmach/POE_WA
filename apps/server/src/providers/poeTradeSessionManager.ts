import { chromium, type BrowserContext } from 'playwright';
import { DomainError } from '@poe-worksmith/domain';
import type { MarketCollectionSource } from '@poe-worksmith/contracts';

type ConnectionStatus = NonNullable<MarketCollectionSource['connectionStatus']>;

export type TradeLoginConfig = {
  username: string;
  password: string;
  profileDirectory: string;
};

export function loadTradeLoginConfig(
  environment: Record<string, string | undefined> = process.env,
): TradeLoginConfig | undefined {
  const username = environment.POE_TRADE_USERNAME;
  const password = environment.POE_TRADE_PASSWORD;
  if (!username && !password) return undefined;
  if (!username || !password)
    throw new Error('Trade login requires both username and password');
  return {
    username,
    password,
    profileDirectory: environment.POE_TRADE_BROWSER_PROFILE_DIR ?? '',
  };
}

/** Owns the website login session; callers receive responses, never cookies. */
export class PoeTradeSessionManager {
  readonly #baseURL: string;
  readonly #config: TradeLoginConfig;
  readonly #onLogin: (() => Promise<void>) | undefined;
  #context: BrowserContext | undefined;
  #login: Promise<void> | undefined;
  #loginFailed = false;
  #sessionId: string | undefined;
  #sessionAvailable = false;
  #sessionAuthenticated = false;
  readonly #sessionSecrets = new Set<string>();
  #stopped = false;
  connectionStatus: ConnectionStatus = 'AUTH_REQUIRED';

  constructor(
    baseURL: string,
    config: TradeLoginConfig,
    options: {
      onLogin?: () => Promise<void>;
    } = {},
  ) {
    this.#baseURL = baseURL;
    this.#config = config;
    this.#onLogin = options.onLogin;
  }

  get redactionValues(): readonly string[] {
    return [...this.#sessionSecrets];
  }

  get sessionAvailable() {
    return this.#sessionAvailable;
  }

  async start(): Promise<ConnectionStatus> {
    try {
      await this.#ensureSession();
    } catch {
      // Expose only a safe connection state; credentials and browser errors stay private.
    }
    return this.connectionStatus;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== this.#baseURL)
      throw new DomainError('PROVIDER_RESPONSE_INVALID');
    init?.signal?.throwIfAborted();
    await this.#ensureSession();
    init?.signal?.throwIfAborted();

    const send = async (): Promise<Response> => {
      const sentSessionId = await this.#readSessionId();
      const context = this.#context;
      if (!context || !sentSessionId)
        throw new DomainError('PROVIDER_UNAVAILABLE');
      const body = init?.body;
      if (
        body !== undefined &&
        body !== null &&
        typeof body !== 'string' &&
        !(body instanceof Uint8Array)
      )
        throw new DomainError('PROVIDER_RESPONSE_INVALID');
      const headers = new Headers(init?.headers);
      headers.delete('cookie');
      const response = await context.request.fetch(url.toString(), {
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(headers),
        ...(body === undefined || body === null ? {} : { data: body }),
        ...(init?.signal ? { signal: init.signal } : {}),
        maxRedirects: 0,
      });
      const responseHeaders = new Headers();
      const headersArray = response.headersArray();
      for (const header of headersArray)
        responseHeaders.append(header.name, header.value);
      const status = response.status();
      const contentLength = Number(responseHeaders.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > 4 * 1024 * 1024) {
        await response.dispose();
        throw new DomainError('PROVIDER_RESPONSE_INVALID');
      }
      let responseBody: Buffer;
      try {
        responseBody = await response.body();
      } finally {
        await response.dispose();
      }
      if (responseBody.byteLength > 4 * 1024 * 1024)
        throw new DomainError('PROVIDER_RESPONSE_INVALID');
      const nativeResponse = new Response(
        [204, 205, 304].includes(status) ? null : new Uint8Array(responseBody),
        { status, headers: responseHeaders },
      );
      nativeResponse.headers.delete('x-poe-session-stale');
      const currentSessionId = await this.#readSessionId();

      if (nativeResponse.status === 401) {
        this.connectionStatus = 'AUTH_REQUIRED';
        if (currentSessionId === sentSessionId) {
          this.#sessionAvailable = false;
          this.#sessionAuthenticated = false;
          await this.#clearSessionCookie();
        } else {
          nativeResponse.headers.set('x-poe-session-stale', 'true');
        }
      }
      this.connectionStatus =
        nativeResponse.status === 401
          ? 'AUTH_REQUIRED'
          : nativeResponse.status === 403
            ? 'ACCESS_DENIED'
            : nativeResponse.status === 429
              ? 'RATE_LIMITED'
              : nativeResponse.status >= 400
                ? 'UNAVAILABLE'
                : 'CONNECTED';
      return nativeResponse;
    };

    return send();
  };

  async stop() {
    this.#stopped = true;
    const context = this.#context;
    this.#context = undefined;
    this.#sessionId = undefined;
    this.#sessionAvailable = false;
    this.#sessionAuthenticated = false;
    await context?.close().catch(() => undefined);
    await this.#login?.catch(() => undefined);
    this.#sessionSecrets.clear();
  }

  async reconnect() {
    this.#loginFailed = false;
    this.#sessionAvailable = false;
    try {
      await this.#ensureSession(true);
      return this.#sessionAvailable && this.#sessionAuthenticated;
    } catch {
      return false;
    }
  }

  async #ensureSession(forceLogin = false) {
    if (this.#stopped) throw new DomainError('PROVIDER_UNAVAILABLE');
    if (this.#login) return this.#login;
    const existing = forceLogin ? undefined : await this.#readSessionId();
    if (this.#login) return this.#login;
    if (existing) {
      this.#sessionAvailable = true;
      if (this.#sessionAuthenticated) {
        if (this.connectionStatus !== 'CONNECTED')
          this.connectionStatus = 'AUTH_REQUIRED';
        return;
      }
    }
    if (this.#loginFailed && !forceLogin)
      throw new DomainError('MARKET_ACCESS_BLOCKED');
    this.#loginFailed = false;
    this.#login = this.#loginToWebsite(forceLogin).finally(() => {
      this.#login = undefined;
    });
    return this.#login;
  }

  async #loginToWebsite(forceLogin: boolean) {
    try {
      if (!this.#context) {
        const context = await chromium.launchPersistentContext(
          this.#config.profileDirectory,
          { chromiumSandbox: true, headless: true },
        );
        if (this.#stopped) {
          await context.close();
          throw new DomainError('PROVIDER_UNAVAILABLE');
        }
        this.#context = context;
      }
      if (forceLogin) await this.#context.clearCookies();
      const page = this.#context.pages()[0] ?? (await this.#context.newPage());
      await page.goto(new URL('/login', this.#baseURL).toString(), {
        waitUntil: 'domcontentloaded',
        timeout: 20_000,
      });
      if (new URL(page.url()).origin !== this.#baseURL) {
        this.connectionStatus = 'ACCESS_DENIED';
        throw new DomainError('MARKET_ACCESS_BLOCKED');
      }
      if (await this.#hasChallenge(page)) {
        this.connectionStatus = 'ACCESS_DENIED';
        throw new DomainError('MARKET_ACCESS_BLOCKED');
      }
      if (
        (await this.#readSessionId()) &&
        (await this.#hasAuthenticatedAccount(page))
      ) {
        this.#sessionAvailable = true;
        this.#sessionAuthenticated = true;
        this.connectionStatus = 'AUTH_REQUIRED';
        return;
      }

      const username = page
        .locator(
          'input[name="login_email"], input[name="username"], input[type="email"]',
        )
        .first();
      if (new URL(page.url()).origin !== this.#baseURL) {
        this.connectionStatus = 'ACCESS_DENIED';
        throw new DomainError('MARKET_ACCESS_BLOCKED');
      }
      const password = page.locator('input[type="password"]').first();
      if (!(await username.count()) || !(await password.count())) {
        this.connectionStatus = 'AUTH_REQUIRED';
        throw new DomainError('MARKET_ACCESS_BLOCKED');
      }
      await username.fill(this.#config.username, { timeout: 5_000 });
      await password.fill(this.#config.password, { timeout: 5_000 });
      const submit = page
        .locator('button[type="submit"], input[type="submit"]')
        .first();
      if (!(await submit.count())) {
        this.connectionStatus = 'AUTH_REQUIRED';
        throw new DomainError('MARKET_ACCESS_BLOCKED');
      }
      await submit.click({ timeout: 5_000 });

      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (await this.#hasChallenge(page)) {
          this.connectionStatus = 'ACCESS_DENIED';
          throw new DomainError('MARKET_ACCESS_BLOCKED');
        }
        if (
          (await this.#readSessionId()) &&
          (await this.#hasAuthenticatedAccount(page))
        ) {
          this.#sessionAvailable = true;
          this.#sessionAuthenticated = true;
          this.connectionStatus = 'AUTH_REQUIRED';
          await this.#onLogin?.();
          return;
        }
        await page.waitForTimeout(500);
      }
      this.connectionStatus = 'AUTH_REQUIRED';
      throw new DomainError('MARKET_ACCESS_BLOCKED');
    } catch (error) {
      this.#loginFailed = true;
      if (error instanceof DomainError) throw error;
      this.connectionStatus = 'UNAVAILABLE';
      // Browser errors may contain page details or user input; discard their causes.
      throw new DomainError('PROVIDER_UNAVAILABLE');
    }
  }

  async #hasChallenge(page: Awaited<ReturnType<BrowserContext['newPage']>>) {
    for (const selector of [
      '#challenge-running, #challenge-form, .cf-browser-verification',
      'iframe[src*="challenges.cloudflare.com"]',
    ])
      for (const element of await page.locator(selector).all())
        if (await element.isVisible().catch(() => false)) return true;
    const title = await page.title().catch(() => '');
    if (
      /just a moment|attention required|verify you are human|один момент|проверка безопасности/iu.test(
        title,
      )
    )
      return true;
    const bodyText = await page
      .locator('body')
      .innerText()
      .catch(() => '');
    return /verify you are human|complete the security check|checking your browser|выполнение проверки безопасности|подтвердите, что вы человек/iu.test(
      bodyText,
    );
  }

  async #hasAuthenticatedAccount(
    page: Awaited<ReturnType<BrowserContext['newPage']>>,
  ) {
    if (new URL(page.url()).origin !== this.#baseURL) return false;
    const statusBar = page.locator('.statusBar');
    const loggedIn = await statusBar
      .getByText(/logged in as/i)
      .first()
      .isVisible()
      .catch(() => false);
    const logout = await statusBar
      .getByText(/log out/i)
      .first()
      .isVisible()
      .catch(() => false);
    return loggedIn && logout;
  }

  async #readSessionId() {
    if (!this.#context) return undefined;
    const cookie = (await this.#context.cookies(this.#baseURL)).find(
      ({ name }) => name === 'POESESSID',
    );
    this.#sessionId =
      cookie && /^[A-Za-z0-9_-]{1,256}$/.test(cookie.value)
        ? cookie.value
        : undefined;
    if (this.#sessionId) this.#rememberSessionSecret(this.#sessionId);
    return this.#sessionId;
  }

  async #clearSessionCookie() {
    this.#sessionId = undefined;
    this.#sessionAuthenticated = false;
    await this.#context?.clearCookies({ name: 'POESESSID' });
  }

  #rememberSessionSecret(value: string) {
    this.#sessionSecrets.add(value);
    while (this.#sessionSecrets.size > 5)
      this.#sessionSecrets.delete(this.#sessionSecrets.values().next().value!);
  }
}
