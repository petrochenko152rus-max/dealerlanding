(() => {
  const root = document.querySelector('[data-hero-carousel]');
  if (!root) return;
  const slides = [...root.querySelectorAll('.hero-image')];
  const counter = root.querySelector('.hero-counter');
  const pauseButton = root.querySelector('.hero-pause');
  const announcement = root.querySelector('.hero-announcement');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let current = 0;
  let paused = motion.matches;
  let timer;

  function show(index, announce = false) {
    current = (index + slides.length) % slides.length;
    slides.forEach((slide, i) => {
      slide.classList.toggle('is-active', i === current);
      slide.setAttribute('aria-hidden', i === current ? 'false' : 'true');
    });
    counter.textContent = `${String(current + 1).padStart(2, '0')} / ${String(slides.length).padStart(2, '0')}`;
    if (announce) announcement.textContent = `Фотография ${current + 1} из ${slides.length}. ${slides[current].alt}`;
  }
  function restart() {
    clearInterval(timer);
    if (!paused && !document.hidden) timer = setInterval(() => show(current + 1), 6500);
  }
  function updatePause() {
    pauseButton.textContent = '';
    pauseButton.classList.toggle('is-paused', paused);
    const label = paused ? 'Возобновить смену фотографий' : 'Остановить смену фотографий';
    pauseButton.setAttribute('aria-label', label);
    pauseButton.title = label;
    restart();
  }
  root.querySelector('.hero-prev').addEventListener('click', () => { show(current - 1, true); restart(); });
  root.querySelector('.hero-next').addEventListener('click', () => { show(current + 1, true); restart(); });
  pauseButton.addEventListener('click', () => { paused = !paused; updatePause(); });
  document.addEventListener('visibilitychange', restart);
  motion.addEventListener?.('change', event => { if (event.matches) { paused = true; updatePause(); } });
  updatePause();

  // A subtle seasonal accent appears around Halloween and disappears automatically.
  const now = new Date();
  const seasonal = (now.getMonth() === 9 && now.getDate() >= 15) || (now.getMonth() === 10 && now.getDate() <= 2);
  document.querySelectorAll('[data-seasonal]').forEach(element => { element.hidden = !seasonal; });
})();
