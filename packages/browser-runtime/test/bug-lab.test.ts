// Ground truth for the Larchwood shop (apps/bug-lab). Each bug in bugs.json
// must show in Chromium when it is on and be gone when it is off; each
// odd-but-correct case must behave the same in both builds. Spekios's own
// control observer must see every trigger as a usable control, otherwise a
// "never tried" result would say nothing about the explorer.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { manifest, parseBugs, startShop } from '../../../apps/bug-lab/shop.mjs';
import { blockedReason, observeControls } from '../src/exploration-policy.js';
import { viewportProfiles, type Viewport } from '../src/viewports.js';

type Mode = 'buggy' | 'fixed';
type Shop = Awaited<ReturnType<typeof startShop>>;
let browser: Browser;
const shops = {} as Record<Mode, Shop>;

before(async () => {
  browser = await chromium.launch({ headless: true, chromiumSandbox: false });
  shops.buggy = await startShop({ bugs: parseBugs('all') });
  shops.fixed = await startShop({ bugs: parseBugs('none') });
});
after(async () => {
  await browser?.close();
  await Promise.all(Object.values(shops).map(shop => shop.close()));
});

type Session = { page: Page; errors: string[]; url: (path: string) => string };
// A fresh browser context per check, like a fresh Spekios browser.
async function session(mode: Mode, fn: (s: Session) => Promise<void>, viewport: Viewport = viewportProfiles.desktop) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(`${error.name}: ${error.message}`));
  try { await fn({ page, errors, url: path => shops[mode].url + path }); } finally { await context.close(); }
}

const text = async (page: Page, selector: string) => ((await page.locator(selector).first().textContent()) ?? '').trim();
const pathOf = (page: Page) => { const url = new URL(page.url()); return url.pathname + url.search; };
async function addToCart(page: Page) {
  const [response] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/cart/items')), page.getByRole('button', { name: 'Add to cart', exact: true }).click()]);
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#add')?.disabled);
  return response.status();
}
async function navigate(page: Page, action: () => Promise<unknown>, url: RegExp) {
  await Promise.all([page.waitForURL(url), action()]);
  await page.waitForLoadState('load');
}
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const bugChecks: Record<string, (mode: Mode) => Promise<void>> = {
  'wishlist-dead': mode => session(mode, async ({ page, url }) => {
    await page.goto(url('/product/oak-side-table'));
    let requests = 0;
    page.on('request', () => { requests++; });
    await page.getByRole('button', { name: 'Save to wishlist' }).click();
    await page.waitForTimeout(200);
    if (mode === 'buggy') {
      assert.equal(await text(page, '#wishlist'), 'Save to wishlist');
      assert.equal(await text(page, '#status'), '');
      assert.equal(requests, 0);
    } else {
      assert.equal(await text(page, '#wishlist'), 'Saved to wishlist');
      assert.equal(await text(page, '#status'), 'Saved to your wishlist.');
    }
  }),
  'returns-404': mode => session(mode, async ({ page, url }) => {
    await page.goto(url('/'));
    const [response] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/shipping-returns'), page.getByRole('link', { name: 'Shipping & returns' }).click()]);
    await page.waitForLoadState('load');
    assert.equal(response.status(), mode === 'buggy' ? 404 : 200);
    assert.equal(await text(page, 'h1'), mode === 'buggy' ? 'Page not found' : 'Shipping & returns');
  }),
  'tracking-500': mode => session(mode, async ({ page, url }) => {
    await page.goto(url('/track'));
    await page.getByRole('searchbox', { name: 'Order number' }).fill('12345');
    const [response] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/track/status'), page.getByRole('button', { name: 'Find my order' }).click()]);
    await page.waitForLoadState('load');
    assert.equal(response.status(), mode === 'buggy' ? 500 : 200);
    if (mode === 'buggy') assert.equal(await text(page, 'body'), 'Internal Server Error');
    else assert.equal(await text(page, 'h1'), 'Order not found');
  }),
  'faq-crash': mode => session(mode, async ({ page, errors, url }) => {
    await page.goto(url('/help'));
    await page.getByRole('button', { name: 'How long does delivery take?' }).click();
    assert.ok(await page.locator('#answer-delivery').isVisible(), 'other questions open');
    await page.getByRole('button', { name: 'Can I exchange an item?' }).click();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#answer-exchange').isVisible(), mode === 'fixed');
    if (mode === 'buggy') assert.match(errors.join('\n'), /TypeError/);
    else assert.deepEqual(errors, []);
  }),
  'search-ignored': mode => session(mode, async ({ page, url }) => {
    await page.goto(url('/shop'));
    await page.getByRole('searchbox', { name: 'Search products' }).fill('lamp');
    await navigate(page, () => page.getByRole('button', { name: 'Search', exact: true }).click(), /q=lamp/);
    assert.equal(await text(page, 'h1'), 'Results for “lamp”');
    assert.match(await text(page, '.results-head p'), mode === 'buggy' ? /^24 products/ : /^3 products/);
    if (mode === 'fixed') assert.ok((await page.locator('.card-name').allTextContents()).every(name => /Lamp/.test(name)));
  }),
  'stock-filter': mode => session(mode, async ({ page, url }) => {
    await page.goto(url('/shop'));
    await navigate(page, () => page.getByRole('checkbox', { name: 'In stock only' }).check(), /stock=1/);
    assert.ok(await page.getByRole('checkbox', { name: 'In stock only' }).isChecked());
    const soldOut = await page.locator('.badge', { hasText: 'Sold out' }).count();
    if (mode === 'buggy') assert.ok(soldOut > 0, 'a sold-out product is listed');
    else { assert.equal(soldOut, 0); assert.match(await text(page, '.results-head p'), /^21 products/); }
  }),
  'price-sort': mode => session(mode, async ({ page, url }) => {
    await page.goto(url('/shop'));
    await navigate(page, () => page.getByRole('combobox', { name: 'Sort by' }).selectOption('price-asc'), /sort=price-asc/);
    const prices = await page.locator('.card-price').evaluateAll(nodes => nodes.map(node => {
      const value = node.lastChild?.textContent ?? '';
      return value === 'Free' ? 0 : Number(value.replace(/[€,]/g, ''));
    }));
    const ascending = prices.every((value, i) => i === 0 || prices[i - 1] <= value);
    assert.equal(ascending, mode === 'fixed', `prices ${prices.join(', ')}`);
  }),
  'cart-total': mode => session(mode, async ({ page, url }) => {
    await page.goto(url('/product/oak-side-table'));
    assert.equal(await addToCart(page), 200);
    await page.goto(url('/cart'));
    assert.equal(await text(page, 'dd.total'), '€145.00');
    await page.getByRole('button', { name: 'Increase quantity of Oak Side Table' }).click();
    assert.equal(await text(page, '.line-total'), '€290.00');
    assert.equal(await text(page, 'dd.total'), mode === 'buggy' ? '€145.00' : '€290.00');
    await page.reload();
    assert.equal(await text(page, 'dd.total'), '€290.00', 'a reload shows the right total');
  }),
  'review-dates': mode => session(mode, async ({ page, url }) => {
    await page.goto(url('/product/oak-side-table'));
    await page.getByRole('button', { name: /^Reviews \(\d\)$/ }).click();
    const reviews = await page.locator('#tab-reviews').innerText();
    if (mode === 'buggy') { assert.match(reviews, /Invalid Date/); assert.match(reviews, /undefined \/ 5/); }
    else { assert.doesNotMatch(reviews, /Invalid Date|undefined|NaN/); assert.match(reviews, /\d{1,2} [A-Z][a-z]+ 2026/); assert.match(reviews, /[1-5] \/ 5/); }
  }),
  'banner-overlap': async mode => {
    for (const viewport of [viewportProfiles.desktop, viewportProfiles.mobile]) await session(mode, async ({ page, url }) => {
      await page.goto(url('/deals'));
      const banner = await page.locator('.sale-banner').boundingBox(), title = await page.locator('h1').boundingBox();
      assert.ok(banner && title);
      assert.equal(overlaps(banner, title), mode === 'buggy', `${viewport.width}px`);
    }, viewport);
  },
  'size-guide-trap': mode => session(mode, async ({ page, url }) => {
    await page.goto(url('/product/oak-side-table'));
    await page.getByRole('button', { name: 'Size guide' }).click();
    assert.ok(await page.getByRole('dialog').isVisible());
    await page.getByRole('button', { name: 'Close' }).click();
    assert.equal(await page.getByRole('dialog').isVisible(), mode === 'buggy');
    if (mode === 'fixed') await page.getByRole('button', { name: 'Size guide' }).click();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').isVisible(), mode === 'buggy');
  }),
  'lost-filters': mode => session(mode, async ({ page, url }) => {
    await page.goto(url('/shop'));
    await navigate(page, () => page.getByRole('combobox', { name: 'Category' }).selectOption('Lighting'), /category=Lighting/);
    await navigate(page, () => page.locator('a.card').first().click(), /\/product\//);
    await navigate(page, () => page.getByRole('link', { name: 'Back to results' }).click(), /\/shop/);
    assert.equal(pathOf(page), mode === 'buggy' ? '/shop' : '/shop?category=Lighting');
    assert.equal(await text(page, 'h1'), mode === 'buggy' ? 'All products' : 'Lighting');
  }),
  'flaky-add': mode => session(mode, async ({ page, url }) => {
    await page.goto(url('/product/oak-side-table'));
    assert.equal(await addToCart(page), 200);
    assert.equal(await text(page, '#status'), 'Added 1 × Oak Side Table to your cart.');
    await page.goto(url('/product/enamel-kettle'));
    assert.equal(await addToCart(page), mode === 'buggy' ? 503 : 200);
    assert.equal(await text(page, '#status'), mode === 'buggy' ? 'Couldn’t add the item. Please try again.' : 'Added 1 × Enamel Kettle to your cart.');
    assert.equal(await text(page, '#cart-link'), mode === 'buggy' ? 'Cart (1)' : 'Cart (2)');
    assert.equal(await addToCart(page), 200, 'the third add works again');
  }),
  'mobile-menu': async mode => {
    await session(mode, async ({ page, url }) => {
      await page.goto(url('/'));
      assert.equal(await page.getByRole('button', { name: 'Menu' }).isVisible(), false, 'no menu button at desktop width');
    });
    await session(mode, async ({ page, url }) => {
      await page.goto(url('/'));
      await page.getByRole('button', { name: 'Menu' }).click();
      const box = await page.locator('#site-nav').getByRole('link', { name: 'Shop' }).boundingBox();
      assert.ok(box);
      const onScreen = box.x >= 0 && box.x + box.width <= viewportProfiles.mobile.width;
      assert.equal(onScreen, mode === 'fixed', `Shop link at x=${box.x}`);
    }, viewportProfiles.mobile);
  },
};

// Odd-looking but correct: identical in both builds.
const decoyChecks: Record<string, (mode: Mode) => Promise<void>> = {
  'sold-out': mode => session(mode, async ({ page, url }) => {
    await page.goto(url('/product/walnut-bench'));
    assert.ok(await page.getByRole('button', { name: 'Sold out' }).isDisabled());
    assert.equal(await page.getByRole('button', { name: 'Add to cart' }).count(), 0);
  }),
  'invalid-promo': mode => session(mode, async ({ page, url }) => {
    await page.goto(url('/product/oak-side-table'));
    await addToCart(page);
    await page.goto(url('/cart'));
    await page.getByRole('textbox', { name: 'Promo code' }).fill('TEST');
    await page.getByRole('button', { name: 'Apply code' }).click();
    assert.equal(await text(page, '#promo-message'), 'This code isn’t valid.');
    await page.getByRole('textbox', { name: 'Promo code' }).fill('welcome10');
    await page.getByRole('button', { name: 'Apply code' }).click();
    assert.equal(await text(page, '#promo-message'), 'Code applied: 10% off your order.');
    assert.equal(await text(page, 'dd.total'), '€130.50');
  }),
  'empty-cart': mode => session(mode, async ({ page, url }) => {
    await page.goto(url('/cart'));
    assert.equal(await text(page, '#cart'), 'Your cart is empty.Continue shopping');
    assert.equal(await text(page, '#cart-link'), 'Cart (0)');
  }),
  'free-sample': mode => session(mode, async ({ page, url }) => {
    await page.goto(url('/product/fabric-swatch-set'));
    assert.equal(await text(page, '.price'), 'Free');
    assert.equal(await addToCart(page), 200);
    await page.goto(url('/cart'));
    assert.equal(await text(page, 'dd.total'), '€0.00');
    assert.match(await page.locator('#summary').innerText(), /Delivery\s+Free/);
  }),
};

test('every entry in bugs.json has a browser check', () => {
  assert.deepEqual(Object.keys(bugChecks).sort(), manifest.bugs.map((bug: { id: string }) => bug.id).sort());
  assert.deepEqual(Object.keys(decoyChecks).sort(), manifest.decoys.map((decoy: { id: string }) => decoy.id).sort());
});

for (const [id, check] of Object.entries(bugChecks)) {
  test(`bug ${id} shows when on and is gone when fixed`, async () => { await check('buggy'); await check('fixed'); });
}
for (const [id, check] of Object.entries(decoyChecks)) {
  test(`correct case ${id} behaves the same in both builds`, async () => { await check('buggy'); await check('fixed'); });
}

type Seen = Awaited<ReturnType<typeof observeControls>>['controls'][number] & { blocked: string | null };
async function scoutControls(page: Page): Promise<Seen[]> {
  const { controls, controls_truncated } = await observeControls(page, []);
  assert.equal(controls_truncated, false, `${pathOf(page)}: controls truncated`);
  const origin = new URL(page.url()).origin;
  const seen = controls.map(control => ({ ...control, blocked: blockedReason(control, origin) }));
  assert.deepEqual(seen.filter(c => c.ambiguous).map(c => `${c.role} ${c.name}`), [], `${pathOf(page)}: ambiguous controls`);
  return seen;
}
function usable(seen: Seen[], role: string, name: string | RegExp) {
  const control = seen.find(c => c.role === role && (typeof name === 'string' ? c.name === name : name.test(c.name)));
  assert.ok(control, `${role} "${name}" is observed`);
  assert.equal(control.blocked, null, `${role} "${name}" is usable`);
  return control;
}

test('Spekios observes every trigger as a usable control', async () => {
  await session('buggy', async ({ page, url }) => {
    await page.goto(url('/'));
    let seen = await scoutControls(page);
    for (const name of ['Shop', 'Deals', 'Help', 'Track order', 'Cart (0)', 'Shipping & returns', 'About Larchwood']) usable(seen, 'link', name);

    await page.goto(url('/shop'));
    seen = await scoutControls(page);
    usable(seen, 'searchbox', 'Search products');
    assert.equal(usable(seen, 'button', 'Search').form?.authorization, 'search');
    for (const name of ['Category', 'Sort by']) usable(seen, 'combobox', name);
    usable(seen, 'checkbox', 'In stock only');
    for (const name of ['Grid', 'List']) usable(seen, 'radio', name);
    usable(seen, 'link', 'Next page');

    await page.goto(url('/product/oak-side-table?from=category%3DFurniture'));
    seen = await scoutControls(page);
    usable(seen, 'link', 'Back to results');
    for (const name of ['Save to wishlist', 'Size guide', 'Add to cart', 'Increase quantity', /^Reviews \(\d\)$/]) usable(seen, 'button', name);
    await page.getByRole('button', { name: 'Size guide' }).click();
    seen = await scoutControls(page);
    usable(seen, 'button', 'Close');
    assert.equal(seen.find(c => c.name === 'Add to cart')?.blocked, 'covered_or_unclickable_control', 'the open dialog covers the page');

    await page.goto(url('/product/oak-side-table'));
    await addToCart(page);
    await page.goto(url('/cart'));
    seen = await scoutControls(page);
    for (const name of ['Increase quantity of Oak Side Table', 'Apply code']) usable(seen, 'button', name);
    usable(seen, 'textbox', 'Promo code');
    assert.equal(seen.find(c => c.name === 'Checkout')?.blocked, 'payment_or_transaction_requires_handoff', 'Spekios leaves checkout alone');

    await page.goto(url('/help'));
    usable(await scoutControls(page), 'button', 'Can I exchange an item?');

    await page.goto(url('/track'));
    seen = await scoutControls(page);
    usable(seen, 'searchbox', 'Order number');
    assert.equal(usable(seen, 'button', 'Find my order').form?.authorization, 'search');

    for (const path of ['/deals', '/about', '/product/walnut-bench', '/product/fabric-swatch-set']) { await page.goto(url(path)); await scoutControls(page); }
  });
  await session('buggy', async ({ page, url }) => {
    await page.goto(url('/'));
    usable(await scoutControls(page), 'button', 'Menu');
  }, viewportProfiles.mobile);
});
