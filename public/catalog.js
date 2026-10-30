(() => {
  'use strict';

  const root = document.querySelector('#catalog-app');
  if (!root) return;

  const MAX_ITEMS = 50;
  const MAX_QUANTITY = 999;
  const PAGE_SIZE = 12;
  const STORAGE_KEY = 'dealerlanding-preorder-v1';
  const priceLink = 'https://cloud.mail.ru/public/ED7Y/Ep5TKqaGm';
  const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const number = new Intl.NumberFormat('ru-RU');
  const state = { products: [], bySku: new Map(), cart: new Map(), query: '', category: '', limit: PAGE_SIZE, status: 'loading', updatedAt: null };

  const el = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = content;
    return node;
  };
  const linkArrow = (external = false) => {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'catalog-link-icon');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', external ? 'M5 19 19 5M8 5h11v11' : 'M5 12h14m-6-6 6 6-6 6');
    svg.append(path);
    return svg;
  };
  const safeText = (value, limit = 240) => typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, limit) : '';
  const validSku = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
  const safePrice = value => {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d{1,2})?$/.test(value.trim()) ? Number(value) : NaN;
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 1_000_000_000 ? parsed : null;
  };
  const photoUrl = value => {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value, location.origin);
      if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.origin === location.origin))) return null;
      return url.href;
    } catch { return null; }
  };
  const detailsFor = input => {
    let entries = [];
    if (Array.isArray(input)) {
      entries = input.map(value => {
        if (typeof value === 'string') return ['', value];
        if (value && typeof value === 'object') return [value.name ?? value.label ?? '', value.value ?? ''];
        return ['', ''];
      });
    } else if (input && typeof input === 'object') {
      entries = Object.entries(input);
    }
    return entries.map(([name, value]) => [safeText(name, 100), safeText(value, 300)]).filter(([, value]) => value).slice(0, 30);
  };
  const normalizeProduct = product => {
    if (!product || typeof product !== 'object' || !validSku(product.sku)) return null;
    const name = safeText(product.name);
    if (!name) return null;
    return {
      sku: product.sku,
      article: safeText(product.article, 128),
      name,
      category: safeText(product.category, 120),
      retailPrice: safePrice(product.retailPrice),
      wholesalePrice: safePrice(product.wholesalePrice),
      image: photoUrl(product.image),
      priceDate: safeText(product.priceDate, 32),
      stockDate: safeText(product.stockDate, 32),
      characteristics: detailsFor(product.characteristics),
    };
  };
  const displayPrice = value => value === null ? 'По запросу' : money.format(value);
  const pluralItems = count => {
    const last = count % 10, lastTwo = count % 100;
    if (last === 1 && lastTwo !== 11) return 'товар';
    if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return 'товара';
    return 'товаров';
  };

  function restoreCart() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (!Array.isArray(saved)) return;
      for (const item of saved.slice(0, MAX_ITEMS)) {
        if (item && validSku(item.sku) && Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= MAX_QUANTITY && !state.cart.has(item.sku)) state.cart.set(item.sku, item.quantity);
      }
    } catch { /* Storage is optional; the current tab remains fully usable. */ }
  }
  function saveCart() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(window.getPreorderItems())); } catch { /* Private browsing may restrict localStorage. */ }
  }
  function summary() {
    let quantity = 0;
    let wholesaleTotal = 0;
    let missingPrices = false;
    let unavailable = 0;
    for (const [sku, count] of state.cart) {
      quantity += count;
      const product = state.bySku.get(sku);
      if (!product) { unavailable++; missingPrices = true; continue; }
      if (product.wholesalePrice === null) missingPrices = true;
      else wholesaleTotal += product.wholesalePrice * count;
    }
    return {
      count: state.cart.size,
      quantity,
      valid: state.cart.size === 0 || (state.status === 'ready' && unavailable === 0),
      unavailable,
      wholesaleTotal: state.cart.size && !missingPrices ? wholesaleTotal : null,
      status: state.status,
    };
  }
  function notifyChange() {
    window.dispatchEvent(new CustomEvent('dealer-preorder-change', { detail: summary() }));
  }
  window.getPreorderItems = () => Array.from(state.cart, ([sku, quantity]) => ({ sku, quantity }));
  window.getPreorderSummary = summary;
  window.clearPreorderItems = () => {
    state.cart.clear();
    saveCart();
    if (state.status === 'ready') renderResults();
    renderCart();
    notifyChange();
  };
  restoreCart();

  const shell = el('div', 'catalog-shell');
  const header = el('div', 'catalog-header');
  const headingGroup = el('div', 'catalog-heading-group');
  headingGroup.append(el('div', 'catalog-kicker', 'КАТАЛОГ ДЛЯ ПАРТНЁРОВ'));
  const title = el('h2', 'catalog-title', 'Мебель для ваших проектов');
  title.id = 'catalog-title';
  headingGroup.append(title, el('p', 'catalog-lead', 'Посмотрите цены и характеристики, выберите товары и приложите предварительный заказ к заявке.'));
  const headerAside = el('div', 'catalog-header-aside');
  const statusLabel = el('p', 'catalog-source-note');
  const priceAnchor = el('a', 'catalog-price-link', 'Открыть прайс-листы и остатки');
  priceAnchor.append(' ', linkArrow(true));
  priceAnchor.href = priceLink;
  priceAnchor.target = '_blank';
  priceAnchor.rel = 'noopener noreferrer';
  headerAside.append(statusLabel, priceAnchor);
  header.append(headingGroup, headerAside);
  const statusArea = el('div', 'catalog-status');
  statusArea.setAttribute('role', 'status');
  statusArea.setAttribute('aria-live', 'polite');
  const content = el('div', 'catalog-content');
  const tools = el('div', 'catalog-tools');
  const searchLabel = el('label', 'catalog-search-label');
  searchLabel.append(el('span', 'catalog-field-label', 'Поиск по названию или артикулу'));
  const searchWrap = el('span', 'catalog-search-wrap');
  const searchIcon = el('span', 'catalog-search-icon', '⌕');
  searchIcon.setAttribute('aria-hidden', 'true');
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Например, стул или артикул';
  search.autocomplete = 'off';
  search.maxLength = 200;
  searchWrap.append(searchIcon, search);
  searchLabel.append(searchWrap);
  const categoryLabel = el('label', 'catalog-category-label');
  categoryLabel.append(el('span', 'catalog-field-label', 'Категория'));
  const category = document.createElement('select');
  category.append(new Option('Все категории', ''));
  categoryLabel.append(category);
  const countLabel = el('div', 'catalog-count');
  countLabel.setAttribute('aria-live', 'polite');
  tools.append(searchLabel, categoryLabel, countLabel);
  const grid = el('div', 'catalog-grid');
  const noResults = el('div', 'catalog-no-results');
  const moreWrap = el('div', 'catalog-more-wrap');
  const more = el('button', 'catalog-more', 'Показать ещё');
  more.type = 'button';
  moreWrap.append(more);
  const cart = el('aside', 'preorder');
  cart.setAttribute('aria-labelledby', 'preorder-title');
  content.append(tools, grid, noResults, moreWrap, cart);
  shell.append(header, statusArea, content);
  root.replaceChildren(shell);

  function renderCharacteristics(product) {
    if (!product.characteristics.length) return null;
    const list = el('dl', 'catalog-characteristics');
    for (const [name, value] of product.characteristics.slice(0, 3)) {
      const row = el('div', 'catalog-characteristic');
      if (name) row.append(el('dt', '', name));
      row.append(el('dd', '', value));
      list.append(row);
    }
    const wrapper = el('div', 'catalog-characteristics-wrap');
    wrapper.append(list);
    if (product.characteristics.length > 3) {
      const details = el('details', 'catalog-more-characteristics');
      details.append(el('summary', '', 'Все характеристики'));
      const extra = el('dl', 'catalog-characteristics');
      for (const [name, value] of product.characteristics.slice(3)) {
        const row = el('div', 'catalog-characteristic');
        if (name) row.append(el('dt', '', name));
        row.append(el('dd', '', value));
        extra.append(row);
      }
      details.append(extra);
      wrapper.append(details);
    }
    return wrapper;
  }

  function productCard(product) {
    const card = el('article', 'product-card');
    const visual = el('div', 'product-visual');
    const fallback = el('div', 'product-no-image');
    fallback.append(el('span', 'product-no-image-symbol', '◌'), el('span', '', 'Фото уточняется'));
    if (product.image) {
      const img = document.createElement('img');
      img.src = product.image;
      img.alt = product.name;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => { img.remove(); visual.append(fallback); }, { once: true });
      visual.append(img);
    } else visual.append(fallback);
    if (product.category) visual.append(el('span', 'product-category', product.category));
    const body = el('div', 'product-body');
    body.append(el('p', 'product-sku', `АРТ. ${product.article || product.sku} · КОД ${product.sku}`), el('h3', 'product-name', product.name));
    const characteristics = renderCharacteristics(product);
    if (characteristics) body.append(characteristics);
    const prices = el('div', 'product-prices');
    const rrc = el('div', 'product-price');
    rrc.append(el('span', '', 'Действующая РРЦ'), el('strong', '', displayPrice(product.retailPrice)));
    const wholesale = el('div', 'product-price product-price-wholesale');
    wholesale.append(el('span', '', 'Действующая опт'), el('strong', '', displayPrice(product.wholesalePrice)));
    prices.append(rrc, wholesale);
    const add = el('button', 'product-add');
    add.type = 'button';
    const current = state.cart.get(product.sku) || 0;
    add.append(el('span', '', current ? `В заказе: ${number.format(current)} шт.` : 'Добавить в заказ'), el('span', 'product-add-symbol', '+'));
    add.setAttribute('aria-label', current ? `Добавить ещё одну единицу: ${product.name}; в заказе ${current}` : `Добавить в заказ: ${product.name}`);
    add.disabled = current >= MAX_QUANTITY || (!current && state.cart.size >= MAX_ITEMS);
    if (add.disabled) add.title = current >= MAX_QUANTITY ? 'Максимум 999 единиц одного товара' : 'В заказе может быть не более 50 товаров';
    add.addEventListener('click', () => {
      const previous = state.cart.get(product.sku) || 0;
      if ((!previous && state.cart.size >= MAX_ITEMS) || previous >= MAX_QUANTITY) return;
      state.cart.set(product.sku, previous + 1);
      saveCart();
      renderResults(product.sku);
      renderCart();
      notifyChange();
      statusArea.textContent = `${product.name} добавлен в предварительный заказ.`;
    });
    add.dataset.sku = product.sku;
    if (product.priceDate) {
      const date = product.priceDate.slice(0, 10).split('-').reverse().join('.');
      body.append(el('p', 'product-date', `Цена из источника на ${date}`));
    }
    body.append(prices, add);
    card.append(visual, body);
    return card;
  }

  function renderResults(focusSku) {
    if (state.status !== 'ready') return;
    const query = state.query.toLocaleLowerCase('ru');
    const matched = state.products.filter(product => (!state.category || product.category === state.category) && (!query || `${product.name} ${product.sku} ${product.article} ${product.category}`.toLocaleLowerCase('ru').includes(query)));
    grid.replaceChildren(...matched.slice(0, state.limit).map(productCard));
    countLabel.textContent = `${number.format(matched.length)} ${pluralItems(matched.length)}`;
    noResults.replaceChildren();
    noResults.hidden = matched.length > 0;
    if (!matched.length) noResults.append(el('strong', '', 'По вашему запросу ничего не найдено'), el('p', '', 'Попробуйте другое название, артикул или категорию.'));
    moreWrap.hidden = matched.length <= state.limit;
    if (!moreWrap.hidden) more.textContent = `Показать ещё · ${number.format(matched.length - state.limit)}`;
    if (focusSku) {
      const next = Array.from(grid.querySelectorAll('.product-add')).find(button => button.dataset.sku === focusSku);
      if (next && !next.disabled) next.focus({ preventScroll: true });
    }
  }

  function cartButton(symbol, label, action, sku) {
    const button = el('button', 'preorder-quantity-button', symbol);
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.dataset.action = action;
    button.dataset.sku = sku;
    return button;
  }
  function setQuantity(sku, value, focusAction = null) {
    if (!state.cart.has(sku)) return;
    if (value <= 0) state.cart.delete(sku);
    else state.cart.set(sku, Math.min(MAX_QUANTITY, Math.max(1, value)));
    saveCart();
    renderResults();
    renderCart(sku, focusAction);
    notifyChange();
  }
  function renderCart(focusSku, focusAction) {
    cart.replaceChildren();
    const header = el('div', 'preorder-header');
    const titleGroup = el('div', 'preorder-title-group');
    titleGroup.append(el('span', 'preorder-kicker', 'ВАША ПОДБОРКА'));
    const title = el('h3', '', 'Предварительный заказ');
    title.id = 'preorder-title';
    titleGroup.append(title);
    const count = el('span', 'preorder-count', `${number.format(state.cart.size)} ${pluralItems(state.cart.size)}`);
    header.append(titleGroup, count);
    cart.append(header);
    if (!state.cart.size) {
      const empty = el('div', 'preorder-empty');
      empty.append(el('div', 'preorder-empty-symbol', '+'), el('p', '', 'Выберите товары в каталоге — они появятся здесь.'), el('span', '', 'Подборку можно приложить к заявке на сотрудничество.'));
      cart.append(empty);
      return;
    }
    const cartSummary = summary();
    const list = el('ul', 'preorder-list');
    for (const [sku, quantity] of state.cart) {
      const product = state.bySku.get(sku);
      const row = el('li', 'preorder-item');
      const info = el('div', 'preorder-item-info');
      info.append(el('strong', '', product?.name || `Артикул ${sku}`));
      info.append(el('span', '', product ? `Арт. ${sku}` : state.status === 'ready' ? 'Нет в текущем прайсе' : 'Проверяем наличие в прайсе'));
      const controls = el('div', 'preorder-item-controls');
      const decrement = cartButton('−', `Уменьшить количество: ${product?.name || sku}`, 'decrement', sku);
      decrement.addEventListener('click', () => setQuantity(sku, quantity - 1, 'decrement'));
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '1'; input.max = String(MAX_QUANTITY); input.step = '1'; input.value = String(quantity);
      input.setAttribute('aria-label', `Количество: ${product?.name || sku}`);
      input.addEventListener('change', () => {
        const value = Number(input.value);
        if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) input.value = String(quantity);
        else setQuantity(sku, value, 'input');
      });
      input.dataset.action = 'input'; input.dataset.sku = sku;
      const increment = cartButton('+', `Увеличить количество: ${product?.name || sku}`, 'increment', sku);
      increment.disabled = quantity >= MAX_QUANTITY;
      increment.addEventListener('click', () => setQuantity(sku, quantity + 1, 'increment'));
      const remove = el('button', 'preorder-remove', 'Удалить');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Удалить из заказа: ${product?.name || sku}`);
      remove.addEventListener('click', () => setQuantity(sku, 0));
      controls.append(decrement, input, increment, remove);
      row.append(info, controls);
      list.append(row);
    }
    cart.append(list);
    if (!cartSummary.valid) {
      const notice = el('p', 'preorder-notice', state.status === 'ready' ? 'Некоторые товары отсутствуют в текущем прайсе. Удалите их из подборки перед отправкой.' : 'Не удалось проверить подборку по актуальному прайсу. Попробуйте обновить страницу позже.');
      notice.setAttribute('role', 'status');
      cart.append(notice);
    }
    const footer = el('div', 'preorder-footer');
    const total = el('div', 'preorder-total');
    const project = document.querySelector('input[name="partnerType"]:checked')?.value === 'project';
    const estimatedTotal = cartSummary.wholesaleTotal === null ? null : project ? cartSummary.wholesaleTotal * 1.1 : cartSummary.wholesaleTotal;
    total.append(el('span', '', project ? 'Ориентир по оптовой цене + 10%' : 'Ориентир по базовой оптовой цене'), el('strong', '', estimatedTotal === null ? 'Уточняется' : money.format(estimatedTotal)));
    const note = el('p', 'preorder-disclaimer', 'Для проектных организаций цена — действующий опт + 10%. Скидка на экспозицию рассчитывается отдельно. Итоговые цены и наличие подтвердим при согласовании.');
    const link = el('a', 'preorder-continue', 'Перейти к анкете');
    link.append(' ', linkArrow());
    link.href = '#application';
    footer.append(total, note, link);
    cart.append(footer);
    if (focusSku && focusAction) {
      const next = Array.from(cart.querySelectorAll('[data-action]')).find(button => button.dataset.action === focusAction && button.dataset.sku === focusSku);
      if (next && !next.disabled) next.focus({ preventScroll: true });
    }
  }

  function renderFailure(isEmpty) {
    state.status = isEmpty ? 'empty' : 'error';
    statusLabel.textContent = 'Актуальные условия — в прайс-листах';
    statusArea.replaceChildren();
    const message = el('div', 'catalog-unavailable');
    message.append(el('strong', '', isEmpty ? 'Каталог пока пуст' : 'Не удалось загрузить каталог'));
    message.append(el('p', '', isEmpty ? 'Посмотрите прайс-листы и складские остатки по ссылке. Если у вас есть вопросы, напишите нам.' : 'Попробуйте обновить страницу позже. Пока можно открыть действующие прайс-листы и складские остатки.'));
    const link = el('a', 'catalog-unavailable-link', 'Открыть прайс-листы и остатки');
    link.append(' ', linkArrow(true));
    link.href = priceLink; link.target = '_blank'; link.rel = 'noopener noreferrer';
    message.append(link);
    statusArea.append(message);
    tools.hidden = true; grid.hidden = true; noResults.hidden = true; moreWrap.hidden = true;
    cart.hidden = state.cart.size === 0;
    renderCart();
    notifyChange();
  }
  search.addEventListener('input', () => { state.query = search.value.trim(); state.limit = PAGE_SIZE; renderResults(); });
  category.addEventListener('change', () => { state.category = category.value; state.limit = PAGE_SIZE; renderResults(); });
  more.addEventListener('click', () => { state.limit += PAGE_SIZE; renderResults(); });
  window.addEventListener('dealer-partner-type-change', () => { renderCart(); notifyChange(); });
  content.hidden = true;
  statusArea.textContent = 'Загружаем каталог…';
  notifyChange();

  async function loadCatalog() {
    try {
      const response = await fetch('/api/catalog', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error('Catalog unavailable');
      const data = await response.json();
      if (!data || !Array.isArray(data.products)) throw new Error('Invalid catalog');
      const products = [];
      const seen = new Set();
      for (const entry of data.products) {
        const product = normalizeProduct(entry);
        if (!product || seen.has(product.sku)) continue;
        seen.add(product.sku); products.push(product);
      }
      if (!products.length) { content.hidden = false; renderFailure(true); return; }
      state.products = products;
      state.bySku = new Map(products.map(product => [product.sku, product]));
      state.status = 'ready';
      const categories = [...new Set(products.map(product => product.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
      category.replaceChildren(new Option('Все категории', ''), ...categories.map(value => new Option(value, value)));
      categoryLabel.hidden = categories.length < 2;
      const updated = data.updatedAt ? new Date(data.updatedAt) : null;
      const dateLabel = updated && Number.isFinite(updated.getTime())
        ? new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Moscow' }).format(updated)
        : safeText(data.updatedAt, 60);
      statusLabel.textContent = dateLabel ? `Остатки из источника на ${dateLabel}` : 'Цены и наличие уточняются при подтверждении заказа';
      statusArea.textContent = '';
      content.hidden = false;
      tools.hidden = false; grid.hidden = false; cart.hidden = false;
      renderResults(); renderCart(); notifyChange();
    } catch {
      content.hidden = false;
      renderFailure(false);
    }
  }
  loadCatalog();
})();
