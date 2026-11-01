// Larchwood's pages. Each page is rendered for one set of active bugs: the
// server decides which code a page gets, so nothing in the page itself says
// whether a bug is on. Keep words such as "bug", "broken" or the bug IDs out
// of everything below that is sent to the browser; a test checks this.
import { CATEGORIES, DELIVERY_PRICE, FREE_DELIVERY_FROM, PAGE_SIZE, PROMO_CODE, orders, productBySlug, products } from './catalogue.mjs';

export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// JSON inside a <script> element must not be able to close it.
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
export const price = n => n === 0 ? 'Free' : '€' + n.toLocaleString('en-GB');

const ICONS = {
  Lighting: '<path d="M38 22h24l8 22H30z" fill="currentColor" opacity=".85"/><rect x="48" y="44" width="4" height="26" fill="currentColor"/><rect x="38" y="70" width="24" height="5" rx="2" fill="currentColor"/>',
  Furniture: '<rect x="32" y="24" width="6" height="50" rx="2" fill="currentColor"/><rect x="32" y="48" width="36" height="7" rx="2" fill="currentColor" opacity=".85"/><rect x="62" y="48" width="6" height="26" rx="2" fill="currentColor"/><rect x="36" y="55" width="4" height="19" fill="currentColor"/>',
  Textiles: '<rect x="28" y="30" width="44" height="40" rx="4" fill="currentColor" opacity=".85"/><path d="M28 42h44M28 54h44" stroke="#fff" stroke-width="2" opacity=".55"/>',
  Kitchen: '<rect x="32" y="32" width="30" height="38" rx="5" fill="currentColor" opacity=".85"/><path d="M62 40h6a6 6 0 0 1 0 12h-6" fill="none" stroke="currentColor" stroke-width="5"/>',
};
const tile = (product, big = false) => `<span class="tile tile-${product.category.toLowerCase()}${big ? ' tile-big' : ''}" aria-hidden="true"><svg viewBox="0 0 100 100">${ICONS[product.category]}</svg></span>`;

const STYLES = `
:root{--bg:#faf8f4;--panel:#fff;--ink:#1f2a24;--muted:#5d6861;--line:#e3ded4;--accent:#2f5d46;--accent-ink:#fff;--warm:#b4683b;--radius:10px}
*{box-sizing:border-box}[hidden]{display:none!important}
html{background:var(--bg)}body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg)}
a{color:var(--accent)}h1,h2,h3{line-height:1.2;margin:0 0 .5em}h1{font-size:2.6rem;letter-spacing:-.02em}h2{font-size:1.4rem}
button,input,select{font:inherit;color:inherit}
button{cursor:pointer;border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:10px 16px}
button:disabled{cursor:not-allowed;opacity:.55}
.primary,a.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);text-decoration:none;display:inline-block;border-radius:8px;padding:10px 18px}
.site-header{background:var(--panel);border-bottom:1px solid var(--line)}
.bar{position:relative;max-width:1120px;margin:0 auto;padding:0 24px;height:64px;display:flex;align-items:center;gap:24px}
.brand{font-weight:700;font-size:1.25rem;letter-spacing:.04em;color:var(--ink);text-decoration:none;text-transform:uppercase}
.site-nav{display:flex;gap:22px;margin-right:auto}.site-nav a,.cart-link{color:var(--ink);text-decoration:none;font-weight:500}
.cart-link{border:1px solid var(--line);border-radius:999px;padding:6px 14px}
.menu-button{display:none}
main{max-width:1120px;margin:0 auto;padding:32px 24px 64px}
.site-footer{border-top:1px solid var(--line);background:var(--panel)}
.foot{max-width:1120px;margin:0 auto;padding:24px;display:flex;flex-wrap:wrap;gap:16px 32px;justify-content:space-between;color:var(--muted)}
.foot nav{display:flex;gap:20px}
.hero{display:grid;grid-template-columns:1.2fr 1fr;gap:40px;align-items:center;padding:24px 0 40px}
.hero p{color:var(--muted);font-size:1.15rem;max-width:34em}.hero-links{display:flex;gap:18px;align-items:center}
.hero-art{background:#e9e2d4;border-radius:16px;aspect-ratio:4/3;display:grid;place-items:center;color:var(--accent)}
.hero-art svg{width:45%}
.points{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin:40px 0 0;padding:0;list-style:none}
.points li{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:20px}
.grid.list{grid-template-columns:1fr}
.card{display:flex;flex-direction:column;gap:6px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px;color:var(--ink);text-decoration:none}
.list .card{flex-direction:row;align-items:center;gap:18px}.list .tile{width:96px;flex:none}
.card-name{font-weight:600}.card-price s,.price s{color:var(--muted);margin-right:6px}
.card-text{display:none;color:var(--muted)}.list .card-text{display:block}
.badge{align-self:flex-start;font-size:.8rem;background:#f3e3d8;color:#7a3d18;border-radius:999px;padding:2px 10px}
.tile{display:grid;place-items:center;aspect-ratio:1;border-radius:8px}
.tile svg{width:62%}.tile-big{border-radius:14px}
.tile-lighting{background:#f1e6cf;color:#a2742c}.tile-furniture{background:#e5ddd2;color:#6b4e35}
.tile-textiles{background:#dde6de;color:#3f6a4f}.tile-kitchen{background:#e2e6ec;color:#4a5a73}
.shop-tools{display:flex;flex-wrap:wrap;gap:14px 22px;align-items:end;margin:0 0 24px;padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius)}
.shop-tools label{display:flex;flex-direction:column;gap:4px;font-size:.9rem;color:var(--muted)}
.shop-tools input[type=search],.shop-tools select,.track-form input,.promo input{padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink)}
.search{display:flex;gap:8px;align-items:end}
.shop-tools label.check{flex-direction:row;align-items:center;gap:8px;color:var(--ink);padding-bottom:10px}
fieldset.view{border:0;margin:0;padding:0 0 10px;display:flex;gap:14px;align-items:center}
fieldset.view legend{float:left;margin-right:6px;font-size:.9rem;color:var(--muted)}
fieldset.view label{flex-direction:row;align-items:center;gap:6px;color:var(--ink)}
.results-head{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap}
.results-head p{color:var(--muted);margin:0 0 16px}
.pager{display:flex;gap:20px;justify-content:center;align-items:center;margin-top:28px}
.empty{font-size:1.1rem}
.back{display:inline-block;margin-bottom:18px}
.product{display:grid;grid-template-columns:1fr 1fr;gap:48px}
.eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:.8rem;color:var(--muted);margin:0 0 8px}
.price{font-size:1.5rem;margin:0 0 4px}.stock{color:var(--muted);margin:0 0 16px}
.buy,.more{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:16px 0}
.qty{display:inline-flex;align-items:center;gap:6px}.qty button{width:40px;padding:8px 0}.qty output{min-width:2ch;text-align:center}
#status{min-height:1.5em;color:var(--accent);font-weight:500}
.tabs{margin-top:40px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:20px}
.tab-buttons{display:flex;gap:8px;margin-bottom:16px}.tab-buttons button[aria-pressed=true]{background:var(--ink);color:#fff;border-color:var(--ink)}
.reviews{list-style:none;margin:0;padding:0;display:grid;gap:14px}.reviews li{border-top:1px solid var(--line);padding-top:12px}
.reviews p{margin:0 0 4px}.stars{color:var(--warm)}.meta{color:var(--muted);font-size:.9rem}
.overlay{position:fixed;inset:0;background:rgba(20,24,22,.5);display:grid;place-items:center;z-index:50}
.dialog{background:var(--panel);border-radius:14px;padding:28px;width:min(520px,92vw)}
.dialog table{width:100%;border-collapse:collapse;margin:12px 0}.dialog th,.dialog td{text-align:left;border-bottom:1px solid var(--line);padding:8px}
.cart-table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius)}
.cart-table th,.cart-table td{text-align:left;padding:12px 14px;border-bottom:1px solid var(--line)}
.cart-bottom{display:grid;grid-template-columns:1fr 340px;gap:32px;margin-top:24px;align-items:start}
.promo label{display:block;margin-bottom:6px;font-weight:500}.promo-row{display:flex;gap:8px}
.summary{display:grid;grid-template-columns:1fr auto;gap:8px 16px;margin:0;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px}
.summary dd{margin:0;text-align:right}.summary .total{font-weight:700;font-size:1.15rem}
.cart-actions{display:flex;justify-content:flex-end;gap:20px;align-items:center;margin-top:24px}
.deals-head{position:relative;margin-bottom:28px}
.sale-banner{background:rgba(214,236,220,.8);color:#1d4a33;border-radius:8px;padding:10px 16px;font-weight:600;margin:0 0 18px}
.deals-head .lead{color:var(--muted)}
.free-sample{margin-top:36px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:22px}
.faq-item{border-bottom:1px solid var(--line)}.faq-q{width:100%;text-align:left;border:0;background:none;padding:16px 0;font-weight:600}
.faq-a p{margin:0 0 16px;color:var(--muted)}
.prose{max-width:46em}.track-form{display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin:20px 0}
.track-form label{display:flex;flex-direction:column;gap:4px}
@media (max-width:720px){
  h1{font-size:2rem}.bar{padding:0 16px;gap:12px}main{padding:24px 16px 48px}
  .menu-button{display:inline-flex;margin-left:auto;padding:8px 14px}
  .site-nav{display:none}
  .site-nav.open{display:flex;flex-direction:column;gap:0;position:absolute;top:64px;left:0;right:0;background:var(--panel);border-bottom:1px solid var(--line);z-index:20;padding:8px 16px}
  .site-nav.open a{padding:12px 0;border-top:1px solid var(--line)}
  .hero,.product,.cart-bottom{grid-template-columns:1fr}.points{grid-template-columns:1fr}
  .grid{grid-template-columns:repeat(2,1fr);gap:12px}
  .cart-table th:nth-child(2),.cart-table td:nth-child(2){display:none}.cart-table th,.cart-table td{padding:10px 8px}
}`;

// Bug-specific CSS. Only the rules for active bugs are sent.
const BUG_STYLES = {
  'mobile-menu': '@media (max-width:720px){.site-nav.open{left:100%;right:auto;width:100%}}',
  'banner-overlap': '.deals-head .sale-banner{position:absolute;top:10px;left:0;right:30%;margin:0;z-index:2}',
};

const COMMON_SCRIPT = `
const CART_KEY='larchwood-cart';
const escapeHtml=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function readCart(){try{const v=JSON.parse(localStorage.getItem(CART_KEY)||'[]');return Array.isArray(v)?v:[];}catch{return [];}}
function showCount(){const n=readCart().reduce((s,l)=>s+(Number(l.qty)||0),0);document.getElementById('cart-link').textContent='Cart ('+n+')';}
function writeCart(cart){try{localStorage.setItem(CART_KEY,JSON.stringify(cart));}catch{}showCount();}
showCount();
const menuButton=document.getElementById('menu-button'),siteNav=document.getElementById('site-nav');
menuButton.addEventListener('click',()=>{const open=siteNav.classList.toggle('open');menuButton.setAttribute('aria-expanded',String(open));});`;

export function layout({ title, body, bugs, script = '' }) {
  const extraCss = Object.entries(BUG_STYLES).filter(([id]) => bugs.has(id)).map(([, css]) => css).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Larchwood</title><link rel="icon" href="data:,"><style>${STYLES}\n${extraCss}</style></head><body>
<header class="site-header"><div class="bar">
<a class="brand" href="/">Larchwood</a>
<nav id="site-nav" class="site-nav" aria-label="Main"><a href="/shop">Shop</a><a href="/deals">Deals</a><a href="/help">Help</a><a href="/track">Track order</a></nav>
<button id="menu-button" class="menu-button" type="button" aria-expanded="false" aria-controls="site-nav">Menu</button>
<a id="cart-link" class="cart-link" href="/cart">Cart (0)</a>
</div></header>
<main>${body}</main>
<footer class="site-footer"><div class="foot"><p>Larchwood · Furniture, lighting and textiles for calm homes.</p>
<nav aria-label="Footer"><a href="/about">About Larchwood</a><a href="/shipping-returns">Shipping &amp; returns</a><a href="/help#contact">Contact us</a></nav></div></footer>
<script>${COMMON_SCRIPT}\n${script}</script></body></html>`;
}

const card = (product, from = '') => `<a class="card" href="/product/${product.slug}${from ? '?from=' + encodeURIComponent(from) : ''}">${tile(product)}<span class="card-name">${esc(product.name)}</span><span class="card-price">${product.was ? `<s>${price(product.was)}</s>` : ''}${price(product.price)}</span><span class="card-text">${esc(product.description)}</span>${product.inStock ? '' : '<span class="badge">Sold out</span>'}</a>`;

export function homePage({ bugs }) {
  const featured = products.filter(p => p.inStock && p.price > 0).slice(0, 4);
  return layout({ title: 'Home', bugs, body: `
<section class="hero"><div><h1>Furniture and lighting for calm homes</h1>
<p>Solid wood, natural fabrics and lamps that make evenings softer. Made to last, delivered free over ${price(FREE_DELIVERY_FROM)}.</p>
<div class="hero-links"><a class="primary" href="/shop">Browse the shop</a><a href="/deals">See this week's offers</a></div></div>
<div class="hero-art" aria-hidden="true"><svg viewBox="0 0 100 100">${ICONS.Lighting}</svg></div></section>
<h2>Customer favourites</h2><div class="grid">${featured.map(p => card(p)).join('')}</div>
<ul class="points"><li><strong>Free delivery over ${price(FREE_DELIVERY_FROM)}</strong><br>Everything else ships for €4.90.</li>
<li><strong>30-day returns</strong><br>Change your mind? Send it back unused.</li><li><strong>Made to last</strong><br>Solid materials, repairable designs.</li></ul>` });
}

export const SORTS = [['featured', 'Featured'], ['price-asc', 'Price: low to high'], ['price-desc', 'Price: high to low'], ['name', 'Name A–Z']];

// The shop's state lives in its query. Only non-default values are kept, so
// the same results always have the same address.
export function shopQuery(params) {
  const q = String(params.get('q') ?? '').trim().slice(0, 60);
  const category = CATEGORIES.includes(params.get('category')) ? params.get('category') : '';
  const stock = params.get('stock') === '1';
  const sort = SORTS.some(([value]) => value === params.get('sort')) ? params.get('sort') : 'featured';
  const view = params.get('view') === 'list' ? 'list' : 'grid';
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  return { q, category, stock, sort, view, page };
}
export function queryString({ q, category, stock, sort, view, page }) {
  const out = new URLSearchParams();
  if (q) out.set('q', q);
  if (category) out.set('category', category);
  if (stock) out.set('stock', '1');
  if (sort !== 'featured') out.set('sort', sort);
  if (view !== 'grid') out.set('view', view);
  if (page > 1) out.set('page', String(page));
  return out.toString();
}

export function shopResults(state, bugs) {
  let list = products.slice();
  if (state.q && !bugs.has('search-ignored')) {
    const words = state.q.toLowerCase().split(/\s+/);
    list = list.filter(p => words.every(word => `${p.name} ${p.category}`.toLowerCase().includes(word)));
  }
  if (state.category) list = list.filter(p => p.category === state.category);
  if (state.stock && !bugs.has('stock-filter')) list = list.filter(p => p.inStock);
  const asText = (a, b) => { const x = String(a.price), y = String(b.price); return x < y ? -1 : x > y ? 1 : 0; };
  if (state.sort === 'price-asc') list.sort(bugs.has('price-sort') ? asText : (a, b) => a.price - b.price);
  if (state.sort === 'price-desc') list.sort(bugs.has('price-sort') ? (a, b) => asText(b, a) : (a, b) => b.price - a.price);
  if (state.sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const page = Math.min(state.page, pages);
  return { total: list.length, pages, page, items: list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) };
}

export function shopPage({ bugs, params }) {
  const state = shopQuery(params);
  const results = shopResults(state, bugs);
  const current = { ...state, page: results.page };
  const from = queryString(current);
  const pageHref = page => { const s = queryString({ ...current, page }); return '/shop' + (s ? '?' + s : ''); };
  const hidden = Object.entries({ category: state.category, stock: state.stock ? '1' : '', sort: state.sort === 'featured' ? '' : state.sort, view: state.view === 'grid' ? '' : state.view })
    .filter(([, value]) => value).map(([name, value]) => `<input type="hidden" name="${name}" value="${esc(value)}">`).join('');
  const filtered = !!(state.q || state.category || state.stock || state.sort !== 'featured');
  const heading = state.q ? `Results for “${esc(state.q)}”` : esc(state.category || 'All products');
  const body = `
<form class="shop-tools search-tools" role="search" method="get" action="/shop">
<div class="search"><label>Search products <input type="search" name="q" maxlength="60" value="${esc(state.q)}"></label>${hidden}<button type="submit">Search</button></div>
</form>
<div class="shop-tools">
<label>Category <select id="category"><option value="">All categories</option>${CATEGORIES.map(c => `<option value="${c}"${c === state.category ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
<label class="check"><input type="checkbox" id="stock"${state.stock ? ' checked' : ''}> In stock only</label>
<label>Sort by <select id="sort">${SORTS.map(([value, label]) => `<option value="${value}"${value === state.sort ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
<fieldset class="view"><legend>View</legend><label><input type="radio" name="view" value="grid"${state.view === 'grid' ? ' checked' : ''}> Grid</label><label><input type="radio" name="view" value="list"${state.view === 'list' ? ' checked' : ''}> List</label></fieldset>
${filtered ? '<a href="/shop">Clear filters</a>' : ''}
</div>
<div class="results-head"><h1>${heading}</h1><p>${results.total} ${results.total === 1 ? 'product' : 'products'}${state.q && state.category ? ` in ${esc(state.category)}` : ''} · Page ${results.page} of ${results.pages}</p></div>
${results.items.length ? `<div class="grid${state.view === 'list' ? ' list' : ''}">${results.items.map(p => card(p, from)).join('')}</div>`
    : `<p class="empty">No products match “${esc(state.q)}”${state.category ? ` in ${esc(state.category)}` : ''}.</p><p><a href="/shop">Browse all products</a></p>`}
${results.pages > 1 ? `<nav class="pager" aria-label="Pages">${results.page > 1 ? `<a href="${esc(pageHref(results.page - 1))}">Previous page</a>` : ''}<span>Page ${results.page} of ${results.pages}</span>${results.page < results.pages ? `<a href="${esc(pageHref(results.page + 1))}">Next page</a>` : ''}</nav>` : ''}`;
  const script = `
function go(name,value,keepPage){const p=new URLSearchParams(location.search);if(value)p.set(name,value);else p.delete(name);if(!keepPage)p.delete('page');const s=p.toString();location.href='/shop'+(s?'?'+s:'');}
document.getElementById('category').addEventListener('change',e=>go('category',e.target.value));
document.getElementById('stock').addEventListener('change',e=>go('stock',e.target.checked?'1':''));
document.getElementById('sort').addEventListener('change',e=>go('sort',e.target.value==='featured'?'':e.target.value));
document.querySelectorAll('input[name=view]').forEach(r=>r.addEventListener('change',()=>go('view',r.value==='grid'?'':r.value,true)));`;
  return layout({ title: state.q ? `Results for ${state.q}` : 'Shop', bugs, body, script });
}

const CARE = {
  Lighting: 'Use an LED bulb up to 8 W. Dust the shade with a soft, dry brush.',
  Furniture: 'Wipe with a damp cloth and re-oil once a year. Keep out of strong sunlight.',
  Textiles: 'Wash at 40 °C, dry flat and iron while still slightly damp.',
  Kitchen: 'Wash by hand in warm, soapy water and dry straight away.',
};

export function productPage({ bugs, product, from }) {
  const back = !bugs.has('lost-filters') && from ? '/shop?' + from : '/shop';
  const fromQuery = from ? '?from=' + encodeURIComponent(from) : '';
  const body = `
<a class="back" href="${esc(back)}">Back to results</a>
<div class="product"><div>${tile(product, true)}</div><div>
<p class="eyebrow">${esc(product.category)}</p><h1>${esc(product.name)}</h1>
<p class="price">${product.was ? `<s>${price(product.was)}</s>` : ''}${price(product.price)}</p>
<p class="stock">${product.inStock ? (product.price === 0 ? 'In stock · free delivery' : 'In stock') : 'Sold out'}</p>
<p>${esc(product.description)}</p>
<div class="buy">${product.inStock
    ? `<div class="qty"><button type="button" id="qty-down" aria-label="Decrease quantity" disabled>−</button><output id="qty">1</output><button type="button" id="qty-up" aria-label="Increase quantity">+</button></div><button type="button" id="add" class="primary">Add to cart</button>`
    : '<button type="button" class="primary" disabled>Sold out</button>'}</div>
<div class="more"><button type="button" id="wishlist" aria-pressed="false">Save to wishlist</button><button type="button" id="size-open">Size guide</button></div>
<p id="status" role="status"></p>
</div></div>
<section class="tabs" aria-label="Product information">
<div class="tab-buttons"><button type="button" data-tab="details" aria-pressed="true">Details</button><button type="button" data-tab="dimensions" aria-pressed="false">Dimensions</button><button type="button" data-tab="reviews" aria-pressed="false">Reviews (${product.reviews.length})</button></div>
<div id="tab-details"><p>${esc(product.description)}</p><p><strong>Care:</strong> ${esc(CARE[product.category])}</p></div>
<div id="tab-dimensions" hidden><p>${esc(product.dimensions)}</p></div>
<div id="tab-reviews" hidden><ul id="review-list" class="reviews"></ul></div>
</section>
<div id="size-guide" class="overlay" hidden><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="size-title">
<h2 id="size-title">Size guide</h2><table><thead><tr><th>Size</th><th>Width</th><th>Depth</th><th>Height</th></tr></thead>
<tbody><tr><td>Small</td><td>40 cm</td><td>35 cm</td><td>45 cm</td></tr><tr><td>Medium</td><td>60 cm</td><td>45 cm</td><td>75 cm</td></tr><tr><td>Large</td><td>90 cm</td><td>55 cm</td><td>110 cm</td></tr></tbody></table>
<p>Measure the space first and leave 10 cm around furniture for air and cleaning.</p>
<button type="button" id="size-close">Close</button></div></div>
<script type="application/json" id="product-data">${json({ slug: product.slug, name: product.name, reviews: product.reviews })}</script>`;
  // The review renderer reads the fields its data has, unless review-dates
  // is on: then it reads names the data does not have.
  const [dateField, ratingField] = bugs.has('review-dates') ? ['posted', 'stars'] : ['date', 'rating'];
  const script = `
const data=JSON.parse(document.getElementById('product-data').textContent);
const status=document.getElementById('status');
let qty=1;const qtyOut=document.getElementById('qty'),down=document.getElementById('qty-down'),up=document.getElementById('qty-up');
function showQty(){qtyOut.textContent=qty;down.disabled=qty<=1;up.disabled=qty>=10;}
if(down){down.addEventListener('click',()=>{qty=Math.max(1,qty-1);showQty();});up.addEventListener('click',()=>{qty=Math.min(10,qty+1);showQty();});}
const add=document.getElementById('add');
if(add)add.addEventListener('click',async()=>{
  add.disabled=true;status.textContent='Adding…';let ok=false;
  try{const r=await fetch('/api/cart/items',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({product:data.slug,quantity:qty})});ok=r.ok;}catch{}
  add.disabled=false;
  if(!ok){status.textContent='Couldn’t add the item. Please try again.';return;}
  const cart=readCart(),line=cart.find(l=>l.slug===data.slug);
  if(line)line.qty=Math.min(10,line.qty+qty);else cart.push({slug:data.slug,qty});
  writeCart(cart);status.textContent='Added '+qty+' × '+data.name+' to your cart.';
});
${bugs.has('wishlist-dead') ? '' : `const wish=document.getElementById('wishlist');
wish.addEventListener('click',()=>{const saved=wish.getAttribute('aria-pressed')!=='true';wish.setAttribute('aria-pressed',String(saved));wish.textContent=saved?'Saved to wishlist':'Save to wishlist';status.textContent=saved?'Saved to your wishlist.':'No longer in your wishlist.';});`}
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-tab]').forEach(o=>{const on=o===b;o.setAttribute('aria-pressed',String(on));document.getElementById('tab-'+o.dataset.tab).hidden=!on;});}));
const longDate=d=>new Date(d+'T12:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});
document.getElementById('review-list').innerHTML=data.reviews.map(r=>'<li><p class="stars">'+'★'.repeat(r.${ratingField}||0)+'☆'.repeat(Math.max(0,5-r.${ratingField})||0)+' <span>'+r.${ratingField}+' / 5</span></p><p>'+escapeHtml(r.text)+'</p><p class="meta">'+escapeHtml(r.author)+' · '+longDate(r.${dateField})+'</p></li>').join('');
const guide=document.getElementById('size-guide');
document.getElementById('size-open').addEventListener('click',()=>{guide.hidden=false;document.getElementById('size-close').focus();});
${bugs.has('size-guide-trap') ? '' : `function closeGuide(){guide.hidden=true;document.getElementById('size-open').focus();}
document.getElementById('size-close').addEventListener('click',closeGuide);
guide.addEventListener('click',e=>{if(e.target===guide)closeGuide();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!guide.hidden)closeGuide();});`}`;
  return layout({ title: product.name, bugs, body, script });
}

export function cartPage({ bugs }) {
  const catalogue = Object.fromEntries(products.map(p => [p.slug, { name: p.name, price: p.price }]));
  const body = `<h1>Your cart</h1><div id="cart"></div>
<script type="application/json" id="catalogue">${json(catalogue)}</script>`;
  const script = `
const catalogue=JSON.parse(document.getElementById('catalogue').textContent);
const root=document.getElementById('cart');let promo=null;
const money=n=>'€'+n.toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2});
const unit=n=>n===0?'Free':'€'+n.toLocaleString('en-GB');
const lines=()=>readCart().filter(l=>catalogue[l.slug]);
function totals(){const subtotal=lines().reduce((s,l)=>s+catalogue[l.slug].price*l.qty,0);const delivery=subtotal===0||subtotal>=${FREE_DELIVERY_FROM}?0:${DELIVERY_PRICE};const discount=promo?Math.round(subtotal*10)/100:0;return {subtotal,delivery,discount,total:subtotal-discount+delivery};}
function showSummary(){const t=totals();document.getElementById('summary').innerHTML='<dt>Subtotal</dt><dd>'+money(t.subtotal)+'</dd><dt>Delivery</dt><dd>'+(t.delivery?money(t.delivery):'Free')+'</dd>'+(t.discount?'<dt>Discount (${PROMO_CODE})</dt><dd>−'+money(t.discount)+'</dd>':'')+'<dt class="total">Total</dt><dd class="total">'+money(t.total)+'</dd>';}
function row(l){const p=catalogue[l.slug],name=escapeHtml(p.name);return '<tr data-slug="'+l.slug+'"><td><a href="/product/'+l.slug+'">'+name+'</a></td><td>'+unit(p.price)+'</td><td><div class="qty"><button type="button" data-step="-1" aria-label="Decrease quantity of '+name+'"'+(l.qty<=1?' disabled':'')+'>−</button><output>'+l.qty+'</output><button type="button" data-step="1" aria-label="Increase quantity of '+name+'"'+(l.qty>=10?' disabled':'')+'>+</button></div></td><td class="line-total">'+money(p.price*l.qty)+'</td></tr>';}
function step(slug,delta){
  const cart=readCart(),line=cart.find(l=>l.slug===slug);if(!line)return;
  line.qty=Math.min(10,Math.max(1,line.qty+delta));writeCart(cart);
  const tr=root.querySelector('tr[data-slug="'+slug+'"]');
  tr.querySelector('output').textContent=line.qty;tr.querySelector('[data-step="-1"]').disabled=line.qty<=1;tr.querySelector('[data-step="1"]').disabled=line.qty>=10;
  tr.querySelector('.line-total').textContent=money(catalogue[slug].price*line.qty);
  ${bugs.has('cart-total') ? '' : 'showSummary();'}
}
function render(){
  const ls=lines();
  if(!ls.length){root.innerHTML='<p class="empty">Your cart is empty.</p><p><a href="/shop">Continue shopping</a></p>';return;}
  root.innerHTML='<table class="cart-table"><thead><tr><th>Product</th><th>Price</th><th>Quantity</th><th>Total</th></tr></thead><tbody>'+ls.map(row).join('')+'</tbody></table>'
    +'<div class="cart-bottom"><div class="promo"><label for="promo">Promo code</label><div class="promo-row"><input id="promo" type="text" maxlength="20" autocomplete="off"><button type="button" id="apply">Apply code</button></div><p id="promo-message" role="status"></p></div><dl class="summary" id="summary"></dl></div>'
    +'<div class="cart-actions"><a href="/shop">Continue shopping</a><a class="primary" href="/checkout">Checkout</a></div>';
  root.querySelectorAll('[data-step]').forEach(b=>b.addEventListener('click',()=>step(b.closest('tr').dataset.slug,Number(b.dataset.step))));
  document.getElementById('apply').addEventListener('click',()=>{
    const code=document.getElementById('promo').value.trim().toUpperCase(),message=document.getElementById('promo-message');
    if(code==='${PROMO_CODE}'){promo=code;message.textContent='Code applied: 10% off your order.';}
    else{promo=null;message.textContent=code?'This code isn’t valid.':'Enter a promo code first.';}
    showSummary();
  });
  showSummary();
}
render();`;
  return layout({ title: 'Cart', bugs, body, script });
}

export function dealsPage({ bugs }) {
  const deals = products.filter(p => p.was);
  return layout({ title: 'Deals', bugs, body: `
<div class="deals-head"><p class="sale-banner">Spring sale · up to 30% off selected pieces · new customers save 10% with ${PROMO_CODE}</p>
<h1>This week's deals</h1><p class="lead">Prices drop every Monday. These offers last until Sunday night.</p></div>
<div class="grid">${deals.map(p => card(p)).join('')}</div>
<section class="free-sample"><h2>Not sure about colours?</h2><p>Order our fabric swatch set. It's free, and so is delivery.</p><a href="/product/fabric-swatch-set">Get the free swatch set</a></section>` });
}

const FAQ = [
  ['delivery', 'How long does delivery take?', 'Most orders arrive in 3 to 5 working days. Large furniture can take up to two weeks.'],
  ['exchange', 'Can I exchange an item?', 'Yes. Within 30 days, send it back unused and tell us what you would like instead.'],
  ['abroad', 'Do you deliver outside the EU?', 'Not yet. We deliver to every EU country.'],
  ['linen', 'How do I care for linen?', 'Wash at 40 °C, dry flat and iron while still slightly damp.'],
  ['free', 'When is delivery free?', `On orders over ${price(FREE_DELIVERY_FROM)}, and always on the fabric swatch set.`],
];

export function helpPage({ bugs }) {
  // With faq-crash on, one question points at an answer ID that does not exist.
  const target = id => bugs.has('faq-crash') && id === 'exchange' ? 'answer-exchanges' : 'answer-' + id;
  return layout({ title: 'Help', bugs, body: `
<h1>Help</h1><section class="prose"><h2>Questions</h2>
${FAQ.map(([id, question, answer]) => `<div class="faq-item"><button type="button" class="faq-q" aria-expanded="false" aria-controls="${target(id)}">${esc(question)}</button><div id="answer-${id}" class="faq-a" hidden><p>${esc(answer)}</p></div></div>`).join('')}
</section>
<section id="contact" class="prose"><h2>Contact us</h2><p>Call us on 020 7946 0321, Monday to Saturday, 9:00 to 18:00. Our shop at 14 Mill Lane is open on the same days.</p></section>`,
  script: `
document.querySelectorAll('.faq-q').forEach(button=>button.addEventListener('click',()=>{const panel=document.getElementById(button.getAttribute('aria-controls'));const open=panel.hidden;panel.hidden=!open;button.setAttribute('aria-expanded',String(open));}));` });
}

export function trackPage({ bugs }) {
  return layout({ title: 'Track order', bugs, body: `
<h1>Track your order</h1><p class="prose">Your order number is the five-digit number on your order confirmation.</p>
<form class="track-form" role="search" method="get" action="/track/status"><label>Order number <input type="search" name="number" required maxlength="12" inputmode="numeric"></label><button type="submit">Find my order</button></form>` });
}

export function trackStatusPage({ bugs, number }) {
  const order = orders.get(number);
  return layout({ title: order ? `Order ${number}` : 'Order not found', bugs, body: order
    ? `<h1>Order ${esc(number)}</h1><p><strong>${esc(order.status)}</strong></p><p class="prose">${esc(order.detail)}</p><p><a href="/track">Track another order</a></p>`
    : `<h1>Order not found</h1><p class="prose">We couldn’t find an order with the number “${esc(number)}”. Check the number on your order confirmation and try again.</p><p><a href="/track">Try another number</a></p>` });
}

export function infoPage({ bugs, path }) {
  const pages = {
    '/about': ['About Larchwood', `<h1>About Larchwood</h1><div class="prose"><p>Larchwood started in 2014 as a two-person workshop making oak side tables. Today we work with twelve small makers across Europe.</p><p>We choose solid materials, design for repair and keep our range small on purpose.</p></div>`],
    '/shipping-returns': ['Shipping & returns', `<h1>Shipping &amp; returns</h1><div class="prose"><h2>Delivery</h2><p>Delivery is free on orders over ${price(FREE_DELIVERY_FROM)} and costs €4.90 otherwise. Most orders arrive in 3 to 5 working days.</p><h2>Returns</h2><p>You have 30 days to send an item back unused. We refund you within five working days of receiving it.</p></div>`],
    '/checkout': ['Checkout', `<h1>Checkout</h1><p class="prose">Check your delivery address and pay securely on the next step.</p><p><a href="/cart">Return to your cart</a></p>`],
  };
  const [title, body] = pages[path];
  return layout({ title, bugs, body });
}

export function notFoundPage({ bugs }) {
  return layout({ title: 'Page not found', bugs, body: `<h1>Page not found</h1><p>The page you were looking for isn’t here.</p><p><a href="/">Go to the home page</a></p>` });
}

export { productBySlug };
