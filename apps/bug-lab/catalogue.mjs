// Larchwood's products, orders and reviews. Plain data, no behaviour.
// The list order is the "Featured" order. Each page of the shop holds 8.
const PRODUCTS = [
  ['brass-table-lamp', 'Brass Table Lamp', 'Lighting', 48, { was: 64, dims: 'Ø 22 × H 45 cm', text: 'A slim brushed-brass lamp with a linen shade and a warm, low glare.' }],
  ['oak-side-table', 'Oak Side Table', 'Furniture', 145, { dims: 'W 45 × D 45 × H 55 cm', text: 'Solid oak with rounded edges and an oiled finish that darkens gently over time.' }],
  ['linen-cushion-cover', 'Linen Cushion Cover', 'Textiles', 24, { dims: '50 × 50 cm', text: 'Stonewashed linen with a hidden zip. Fits a standard 50 cm cushion.' }],
  ['stoneware-mug', 'Stoneware Mug', 'Kitchen', 12, { dims: 'Ø 9 × H 10 cm, 350 ml', text: 'Hand-glazed stoneware in a speckled oat colour. Dishwasher safe.' }],
  ['ceramic-pendant-light', 'Ceramic Pendant Light', 'Lighting', 95, { stock: false, dims: 'Ø 30 × H 18 cm', text: 'A matte white ceramic dome on a 1.5 m fabric cord.' }],
  ['ash-dining-chair', 'Ash Dining Chair', 'Furniture', 189, { dims: 'W 48 × D 52 × H 80 cm', text: 'A steam-bent ash frame with a woven paper-cord seat.' }],
  ['jute-rug', 'Jute Rug', 'Textiles', 240, { was: 290, dims: '160 × 230 cm', text: 'Hand-braided jute in a natural tone, firm underfoot and easy to vacuum.' }],
  ['enamel-kettle', 'Enamel Kettle', 'Kitchen', 55, { dims: '1.8 l', text: 'A classic enamel kettle for gas, electric and induction hobs.' }],
  ['linen-floor-lamp', 'Linen Floor Lamp', 'Lighting', 129, { dims: 'Ø 40 × H 150 cm', text: 'A tall tripod lamp in smoked oak with a pleated linen shade.' }],
  ['walnut-bench', 'Walnut Bench', 'Furniture', 320, { stock: false, dims: 'W 120 × D 35 × H 45 cm', text: 'A low walnut bench for a hallway or the end of a bed.' }],
  ['cotton-bath-towel', 'Cotton Bath Towel', 'Textiles', 29, { dims: '70 × 140 cm', text: 'Heavy organic cotton terry in soft sand.' }],
  ['olive-wood-board', 'Olive Wood Board', 'Kitchen', 35, { dims: '40 × 20 cm', text: 'Each board is cut from a single piece of olive wood, so the grain is unique.' }],
  ['rattan-desk-lamp', 'Rattan Desk Lamp', 'Lighting', 64, { dims: 'Ø 25 × H 38 cm', text: 'A hand-woven rattan shade on a steel base with an inline switch.' }],
  ['pine-bookcase', 'Pine Bookcase', 'Furniture', 450, { dims: 'W 80 × D 30 × H 180 cm', text: 'Five deep shelves in solid pine, ready to wax or paint.' }],
  ['linen-curtain-panel', 'Linen Curtain Panel', 'Textiles', 85, { was: 110, dims: '140 × 260 cm', text: 'Lightweight linen that filters daylight. Sold as a single panel.' }],
  ['glass-carafe', 'Glass Carafe', 'Kitchen', 42, { dims: '1 l', text: 'Mouth-blown glass with a fitted beaker that doubles as a lid.' }],
  ['glass-globe-wall-light', 'Glass Globe Wall Light', 'Lighting', 72, { dims: 'Ø 18 cm', text: 'An opal glass globe on a brass back plate, for hallways and bathrooms.' }],
  ['cane-lounge-chair', 'Cane Lounge Chair', 'Furniture', 780, { dims: 'W 70 × D 78 × H 75 cm', text: 'A deep, low lounge chair with a cane back and a linen seat pad.' }],
  ['moss-wool-throw', 'Moss Wool Throw', 'Textiles', 110, { stock: false, dims: '130 × 180 cm', text: 'Lambswool woven in Wales, in a deep moss green.' }],
  ['cast-iron-pan', 'Cast Iron Pan', 'Kitchen', 160, { dims: 'Ø 28 cm', text: 'Pre-seasoned cast iron that goes from hob to oven.' }],
  ['paper-lantern-shade', 'Paper Lantern Shade', 'Lighting', 18, { dims: 'Ø 45 cm', text: 'A round rice-paper shade that softens any ceiling light.' }],
  ['elm-dining-table', 'Elm Dining Table', 'Furniture', 1250, { dims: 'W 200 × D 90 × H 75 cm', text: 'A six-seat table in solid elm with a hand-planed top.' }],
  ['fabric-swatch-set', 'Fabric Swatch Set', 'Textiles', 0, { dims: '12 swatches, 10 × 10 cm', text: 'A free sample of our twelve linens and wools, sent with free delivery.' }],
  ['linen-tea-towel', 'Linen Tea Towel', 'Kitchen', 9, { dims: '50 × 70 cm', text: 'A soft linen tea towel with a hanging loop.' }],
];

export const CATEGORIES = ['Lighting', 'Furniture', 'Textiles', 'Kitchen'];

const AUTHORS = ['Maya R.', 'Tom H.', 'Inès D.', 'Jonas K.', 'Priya S.', 'Lucas B.', 'Hanna W.', 'Omar F.'];
const REVIEWS = {
  Lighting: ['Gives a lovely soft light in the evening.', 'Well made and easy to set up.', 'Smaller than I expected, but very pretty.'],
  Furniture: ['Solid and beautifully finished.', 'Took ten minutes to assemble. Very sturdy.', 'The wood is even nicer in person.'],
  Textiles: ['Soft from the first wash.', 'The colour is exactly as pictured.', 'Good quality for the price.'],
  Kitchen: ['Use it every day.', 'Feels well made and heavy in the hand.', 'Arrived quickly and well packed.'],
};

// Reviews are generated the same way every time, so evidence stays comparable.
function reviewsFor(index, category) {
  return [0, 1, 2].slice(0, 2 + (index % 2)).map(n => {
    const day = 1 + ((index * 7 + n * 11) % 27), month = 1 + ((index + n * 3) % 9);
    return {
      author: AUTHORS[(index + n * 3) % AUTHORS.length],
      date: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      rating: 5 - ((index + n) % 3),
      text: REVIEWS[category][(index + n) % 3],
    };
  });
}

export const products = PRODUCTS.map(([slug, name, category, price, extra], index) => ({
  slug, name, category, price, was: extra.was ?? null, inStock: extra.stock !== false,
  dimensions: extra.dims, description: extra.text, reviews: reviewsFor(index, category),
}));

export const productBySlug = new Map(products.map(product => [product.slug, product]));

export const orders = new Map([
  ['10482', { status: 'Shipped', detail: 'Your parcel left our warehouse on Monday and should arrive by Thursday.' }],
  ['10517', { status: 'Being packed', detail: 'We are packing your order and will send it within two working days.' }],
]);

export const PROMO_CODE = 'WELCOME10';
export const FREE_DELIVERY_FROM = 100;
export const DELIVERY_PRICE = 4.9;
export const PAGE_SIZE = 8;
