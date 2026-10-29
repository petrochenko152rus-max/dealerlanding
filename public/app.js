const $ = (selector) => document.querySelector(selector);
const form = $('#dealer-form');
const formats = {
  online: { title: 'Интернет-магазин', icon: 'store', condition: 'От 100 SKU на сайте · закупка от 1 единицы', price: 'Действующая опт' },
  showroom: { title: 'Салон / шоурум', icon: 'chair', condition: 'От 5 разных моделей на экспозиции · до 20% на выставочные образцы', price: 'Действующая опт' },
  project: { title: 'Проектная организация', icon: 'project', condition: 'Без размещения · ориентир от 300 000 ₽ в квартал', price: 'Действующая опт + 10%' },
};
let selectedType = 'online';
let companyFile = null;
let photos = [];
let submitting = false;
const companyInput = $('#company-file');
const photoInput = $('#store-photos');
const errorBox = $('#form-error');

function setFormat(type) {
  selectedType = type;
  const format = formats[type];
  document.querySelectorAll('.format-card').forEach(card => {
    const selected = card.querySelector('input').value === type;
    card.classList.toggle('selected', selected);
    card.querySelector('.card-select > span').textContent = selected ? 'Формат выбран' : 'Выбрать формат';
  });
  $('#summary-title').textContent = format.title;
  $('#summary-icon use').setAttribute('href', `#${format.icon}`);
  $('#summary-condition').textContent = format.condition;
  $('#summary-price').textContent = format.price;
  const website = form.elements.website;
  $('#website-field').firstChild.textContent = type === 'online' ? 'Сайт магазина *' : 'Сайт компании / необязательно';
  website.required = type === 'online';
  $('#address-field').hidden = type !== 'showroom';
  form.elements.address.required = type === 'showroom';
  $('#photos-field').hidden = type !== 'showroom';
  photoInput.required = type === 'showroom';
  form.elements.termsAccepted.checked = false;
  updateFileValidity();
  clearServerErrors();
}
document.querySelectorAll('[name=partnerType]').forEach(radio => radio.addEventListener('change', () => setFormat(radio.value)));

const menuToggle = $('.menu-toggle');
menuToggle.addEventListener('click', () => {
  const expanded = menuToggle.getAttribute('aria-expanded') !== 'true';
  menuToggle.setAttribute('aria-expanded', String(expanded));
  menuToggle.setAttribute('aria-label', expanded ? 'Закрыть меню' : 'Открыть меню');
  $('#mobile-nav').hidden = !expanded;
});
$('#mobile-nav').querySelectorAll('a').forEach(link => link.addEventListener('click', () => {
  menuToggle.setAttribute('aria-expanded', 'false');
  menuToggle.setAttribute('aria-label', 'Открыть меню');
  $('#mobile-nav').hidden = true;
}));
const privacyDialog = $('#privacy-dialog');
$('#privacy-open').addEventListener('click', () => privacyDialog.showModal());
$('#privacy-close').addEventListener('click', () => privacyDialog.close());
privacyDialog.addEventListener('click', event => { if (event.target === privacyDialog) {
  const bounds = privacyDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) privacyDialog.close();
} });
$('#year').textContent = new Date().getFullYear();

function clearServerErrors() {
  errorBox.hidden = true;
  form.querySelectorAll('[aria-invalid=true]').forEach(field => field.removeAttribute('aria-invalid'));
  for (const field of form.elements) if (field.dataset.serverError) {
    field.setCustomValidity('');
    delete field.dataset.serverError;
  }
}
form.addEventListener('input', event => {
  if (event.target.dataset.serverError) {
    event.target.setCustomValidity('');
    delete event.target.dataset.serverError;
    event.target.removeAttribute('aria-invalid');
  }
});

function updateFileValidity() {
  form.elements.requisites.required = !companyFile;
  form.elements.requisites.minLength = companyFile ? 0 : 10;
  photoInput.setCustomValidity(selectedType === 'showroom' && photos.length < 2 ? 'Добавьте не менее двух фотографий магазина / шоурума.' : '');
}
function fileError(message) {
  $('#attachment-error').textContent = message;
  $('#attachment-error').hidden = !message;
}
function fileType(file) {
  if (file.type) return file.type;
  const extension = file.name.split('.').pop().toLowerCase();
  return ({ pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[extension] || '';
}
function validateFiles(list, purpose) {
  if (list.length > (purpose === 'photo' ? 4 : 1)) return purpose === 'photo' ? 'Выберите не более 4 фотографий.' : 'Выберите один файл с реквизитами.';
  for (const file of list) {
    const types = purpose === 'photo' ? ['image/jpeg', 'image/png', 'image/webp'] : ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (!types.includes(fileType(file))) return `Файл «${file.name}»: выберите ${purpose === 'photo' ? 'JPG, PNG или WebP' : 'PDF, JPG, PNG или WebP'}.`;
    if (file.size > 2 * 1024 * 1024 || file.size === 0) return `Файл «${file.name}» должен быть не пустым и не больше 2 МБ.`;
    if (file.name.length > 150) return 'Сократите название файла до 150 символов.';
  }
  const combined = purpose === 'photo' ? [...list, ...(companyFile ? [companyFile] : [])] : [...list, ...photos];
  if (combined.reduce((sum, file) => sum + file.size, 0) > 7 * 1024 * 1024) return 'Общий размер вложений не должен превышать 7 МБ.';
  return '';
}
function renderFiles() {
  const render = (list, element, purpose) => {
    element.replaceChildren();
    list.forEach((file, index) => {
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = file.name;
      const size = document.createElement('small');
      size.textContent = `${Math.max(1, Math.round(file.size / 1024))} КБ`;
      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Удалить ${file.name}`);
      remove.addEventListener('click', () => {
        if (purpose === 'requisites') { companyFile = null; companyInput.value = ''; }
        else { photos.splice(index, 1); syncPhotoInput(); }
        fileError(''); renderFiles(); updateFileValidity();
      });
      item.append(name, size, remove); element.append(item);
    });
  };
  render(companyFile ? [companyFile] : [], $('#company-file-list'), 'requisites');
  render(photos, $('#photo-file-list'), 'photo');
}
function syncPhotoInput() {
  const transfer = new DataTransfer();
  photos.forEach(file => transfer.items.add(file));
  photoInput.files = transfer.files;
}
companyInput.addEventListener('change', () => {
  const list = Array.from(companyInput.files);
  const message = validateFiles(list, 'requisites');
  if (message) { companyInput.value = ''; fileError(message); return; }
  companyFile = list[0] || null;
  fileError(''); renderFiles(); updateFileValidity();
});
photoInput.addEventListener('change', () => {
  const newFiles = Array.from(photoInput.files);
  const list = [...photos];
  newFiles.forEach(file => { if (!list.some(existing => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified)) list.push(file); });
  const message = validateFiles(list, 'photo');
  if (message) { syncPhotoInput(); fileError(message); return; }
  photos = list;
  syncPhotoInput(); fileError(''); renderFiles(); updateFileValidity();
});

async function attachment(file, purpose) {
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('Не удалось прочитать файл. Выберите его заново.'));
    reader.readAsDataURL(file);
  });
  return { name: file.name, type: fileType(file), data, purpose };
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (submitting) return;
  clearServerErrors(); updateFileValidity();
  if (!form.reportValidity()) return;
  submitting = true;
  const button = form.querySelector('[type=submit]');
  button.disabled = true; button.querySelector('span').textContent = 'Отправляем заявку…';
  form.setAttribute('aria-busy', 'true');
  try {
    const payload = Object.fromEntries(new FormData(form));
    payload.type = selectedType;
    payload.termsAccepted = form.elements.termsAccepted.checked;
    payload.consent = form.elements.consent.checked;
    if (selectedType !== 'showroom') payload.address = '';
    payload.attachments = await Promise.all([
      ...(companyFile ? [attachment(companyFile, 'requisites')] : []),
      ...(selectedType === 'showroom' ? photos.map(file => attachment(file, 'photo')) : []),
    ]);
    const response = await fetch('/api/applications', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(45000),
    });
    const result = await response.json();
    if (!response.ok || result.success !== true) {
      if (result.fields) for (const [name, message] of Object.entries(result.fields)) {
        const field = form.elements.namedItem(name);
        if (field && typeof field.setCustomValidity === 'function') {
          field.setCustomValidity(message); field.dataset.serverError = 'true'; field.setAttribute('aria-invalid', 'true');
        }
      }
      throw new Error(result.message || 'Не удалось отправить заявку. Попробуйте позже.');
    }
    $('#success-email').textContent = payload.email;
    form.hidden = true;
    $('#success-panel').hidden = false;
    $('#success-panel').focus({ preventScroll: true });
    $('#success-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    form.reset(); companyFile = null; photos = []; renderFiles();
  } catch (error) {
    errorBox.textContent = ['TimeoutError', 'AbortError'].includes(error.name) ? 'Ответ от почты задерживается. Повторите отправку или свяжитесь с Семёном.' : error instanceof TypeError ? 'Нет связи с сервером. Проверьте подключение и попробуйте ещё раз.' : error.message;
    errorBox.hidden = false;
    const invalid = form.querySelector('[aria-invalid=true]');
    if (invalid) invalid.focus(); else errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } finally {
    submitting = false; button.disabled = false;
    button.querySelector('span').textContent = 'Отправить заявку и получить КП';
    form.removeAttribute('aria-busy');
  }
});
$('#new-application').addEventListener('click', () => {
  $('#success-panel').hidden = true;
  form.hidden = false; setFormat(selectedType);
  form.elements.company.focus();
});
updateFileValidity();
